import store from '@/store';
import log from '@/transitional/log';
import createTask from '@/transitional/tasks';
import {
  tabLoaded,
  closeTab,
  runContentScript,
  getDocumentByAjax,
  createTabFromRequest,
} from '@/backend/utils';
import { taskFunction } from './utils';
import { getElementFromDocument, getHtmlFromNode } from '../content_scripts/helpers/elements';
import {
  CaptchaLoadError, LogoutError, ElementNotFoundError, CaptchaSolveError,
} from '@/backend/errors';
import { checkLoggedInProfile, checkLogin } from '../content_scripts/helpers/check_login';
import { TaskState, TaskId } from '@/store/modules/tasks';
import { Client, ZraDomain, ZraCaptchaUrl } from '../constants';
import { RequiredBy, round } from '@/utils';
import config from '@/transitional/config';
import axios from 'axios';

/**
 * Creates a canvas from a HTML image element
 * @param image The image to use
 * @param scale Optional scale to apply to the image
 */
function imageToCanvas(image: HTMLImageElement, scale: number = 1): HTMLCanvasElement {
  const width = image.width * scale;
  const height = image.height * scale;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
}

/**
 * Generates a new captcha as a canvas
 * @param scale Optional scale to help recognize the image
 */
function getFreshCaptcha(scale: number = 1): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Set crossOrigin to 'anonymous' to fix the "operation is insecure" error in Firefox.
    // See https://stackoverflow.com/a/17035132/2999486.
    image.crossOrigin = 'anonymous';
    const src = `${ZraCaptchaUrl}?${Math.random()}`;
    image.src = src;
    image.onload = function onload() {
      resolve(imageToCanvas(image, scale));
    };
    image.onerror = function onerror() {
      reject(new CaptchaLoadError('Error loading captcha.', null, { src }));
    };
  });
}

interface TensorFlowRequestResponse {
  outputs: {
    probability: number;
    output: string;
  };
}

interface CaptchaRecognitionData {
  /** Prediction confidence */
  probability: number;
  text: string;
}

async function ocrCaptchaCanvas(canvas: HTMLCanvasElement): Promise<CaptchaRecognitionData> {
  const base64Canvas = canvas.toDataURL().replace('data:image/png;base64,', '');
  const { data: response } = await axios.post<TensorFlowRequestResponse>(
    `${config.tensorflowCaptchaServerUrl}/v1/models/captcha:predict`,
    { inputs: { input: { b64: base64Canvas } } },
  );
  const { probability, output } = response.outputs;
  return {
    probability,
    text: output,
  };
}

const captchaLength = 6;

/**
 * Gets and solves the login captcha.
 * @param maxCaptchaRefreshes
 * The maximum number of times that a new captcha will be loaded if the OCR fails
 * @param minRecognitionProbability
 * The minimum recognition probability before the recognition is discarded and a fresh captcha
 * attempted.
 * @returns The solution to the captcha.
 */
async function getCaptchaText(
  maxCaptchaRefreshes: number,
  minRecognitionProbability: number = 0.98,
): Promise<string | null> {
  // Solve captcha
  let answer: string | null = null;
  let refreshes = 0;
  /* eslint-disable no-await-in-loop */
  while (refreshes < maxCaptchaRefreshes) {
    const captcha = await getFreshCaptcha();
    const data = await ocrCaptchaCanvas(captcha);
    answer = data.text.trim();
    if (config.debug.captchaSolving) {
      console.log(`[Attempt ${refreshes}]: Recognized captcha as '${answer}'. Probability ${round(data.probability, 4) * 100}%.`);
    }

    // If captcha reading still failed, try again with a new one.
    if (answer.length !== captchaLength || data.probability < minRecognitionProbability) {
      if (config.debug.captchaSolving) {
        if (data.probability < minRecognitionProbability) {
          console.log(`[Attempt ${refreshes}]: Recognized captcha probability was too low. (${round(data.probability, 4) * 100}% < ${round(minRecognitionProbability, 4) * 100}%)`);
        } else if (answer.length !== captchaLength) {
          console.log(`[Attempt ${refreshes}]: Recognized captcha was not ${captchaLength} characters.`);
        }
      }
      refreshes++;
    } else {
      break;
    }
  }
  /* eslint-enable no-await-in-loop */
  return answer;
}

interface LoginFnOptions<KeepTabOpen extends boolean> {
  client: Client;
  parentTaskId: TaskId;
  /** Whether the logged in tab should be kept open after logging in. */
  keepTabOpen?: KeepTabOpen;
  /**
   * Whether to close the tab if any errors occurred when checking if the client was successfully
   * logged in. Only used when `keepTabOpen` is true.
   */
  closeOnErrors?: boolean;
}

interface LoginResponse<TabId extends number | null> {
  /** The ID of the logged in tab. */
  tabId: TabId;
  /** Any error that occurred checking if the client was successfully logged in. */
  checkLoginError?: any;
}

export async function login<T extends boolean>(options: RequiredBy<LoginFnOptions<T>, 'keepTabOpen'>): Promise<LoginResponse<T extends true ? number : null>>;
export async function login(options: LoginFnOptions<any>): Promise<LoginResponse<null>>;
/**
 * Creates a new tab, logs in and then closes the tab
 * @throws {import('@/backend/errors').ExtendedError}
 */
export async function login({
  client,
  parentTaskId,
  keepTabOpen = false,
  closeOnErrors = true,
}: LoginFnOptions<boolean>): Promise<LoginResponse<number | null>> {
  const task = await createTask(store, {
    title: 'Login',
    parent: parentTaskId,
    unknownMaxProgress: false,
    progressMax: 4,
    status: 'Getting session hash',
  });

  log.setCategory('login');
  log.log(`Logging in client "${client.name}"`);

  return taskFunction({
    task,
    setState: false,
    async func() {
      let tabId: number | null = null;
      task.addStep('Solving captcha');
      try {
        const captchaText = await getCaptchaText(10);

        if (captchaText === null) {
          throw new CaptchaSolveError('Failed to solve captcha');
        }

        const loginRequest = {
          url: `${ZraDomain}/login`,
          data: {
            username: client.username,
            password: client.password,
            captcha: captchaText,
          },
        };

        task.addStep('Waiting for login to complete');
        let doc = null;
        if (keepTabOpen) {
          const tab = await createTabFromRequest(loginRequest);
          tabId = tab.id;
          await tabLoaded(tabId);
        } else {
          doc = await getDocumentByAjax(Object.assign({ method: 'post' }, loginRequest));
        }

        let checkLoginError;
        try {
          task.addStep('Checking if login was successful');
          if (keepTabOpen) {
            await runContentScript(tabId, 'check_login', { client });
          } else {
            checkLogin(doc, client);
          }
          const checkLoginDoc = await getDocumentByAjax({
            url: `${ZraDomain}/security/userprofile`,
          });
          checkLoggedInProfile(checkLoginDoc, client);
          log.log(`Done logging in "${client.name}"`);
          task.state = TaskState.SUCCESS;
        } catch (error) {
          task.setError(error);
          checkLoginError = error;
          // By default, close the tab if logging in failed. This can be disabled by setting
          // `closeOnErrors` to false.
          if (keepTabOpen && closeOnErrors && tabId !== null) {
            // TODO: Catch tab close errors
            closeTab(tabId);
          }
        }

        return {
          tabId,
          checkLoginError,
        };
      } catch (error) {
        /*
        If opening the login tab failed, the tab ID will never be returned.
        Thus, nothing else will be able to close the login tab and it must be closed
        here instead.

        We may want to make it possible to return the tab ID even if an error occurs in the future,
        however, this is not necessary at the moment since the tab is useless if it didn't load.
        */
        if (keepTabOpen && tabId !== null) {
          // TODO: Catch tab close errors
          closeTab(tabId);
        }
        throw error;
      }
    },
  });
}

interface LogoutFnOptions {
  parentTaskId: TaskId;
}

/**
 * Creates a new tab, logs out and then closes the tab
 */
export async function logout({ parentTaskId }: LogoutFnOptions): Promise<void> {
  const task = await createTask(store, {
    title: 'Logout',
    parent: parentTaskId,
    indeterminate: true,
  });

  log.setCategory('logout');
  log.log('Logging out');
  return taskFunction({
    task,
    async func() {
      const doc = await getDocumentByAjax({ url: `${ZraDomain}/logout` });
      try {
        getElementFromDocument(doc, '.login-card', 'login card');
      } catch (error) {
        if (error instanceof ElementNotFoundError) {
          throw new LogoutError('Logout redirect page is missing the login form', null, {
            html: getHtmlFromNode(doc),
          });
        } else {
          throw error;
        }
      }
      log.log('Done logging out');
    },
  });
}

interface RobustLoginFnOptions<KeepTabOpen extends boolean> extends LoginFnOptions<KeepTabOpen> {
  /** The maximum number of times an attempt should be made to login to a client. */
  maxAttempts: number;
  /**
   * Whether to close the tab if any errors occur when checking if the client was successfully logged
   * in. Only used when `keepTabOpen` is true. If more than one login attempt is made, only the tab
   * from the last attempt will be kept open on errors.
   */
  closeOnErrors?: boolean;
}

export async function robustLogin<T extends boolean>(options: RequiredBy<RobustLoginFnOptions<T>, 'keepTabOpen'>): Promise<T extends true ? number : null>;
export async function robustLogin(options: RobustLoginFnOptions<any>): Promise<null>;
/**
 * Logs in a client and retries if already logged in as another client
 * @returns The ID of the logged in tab.
 */
export async function robustLogin({
  client,
  parentTaskId,
  maxAttempts,
  keepTabOpen = false,
  closeOnErrors = true,
}: RobustLoginFnOptions<boolean>): Promise<number | null> {
  const task = await createTask(store, {
    title: 'Robust login',
    parent: parentTaskId,
    unknownMaxProgress: false,
    // After every login attempt except the last one, we logout.
    // So if the maximum number of login attempts is 3, we login 3 times but only logout 2 times.
    // Thus the total number of tasks would be 3 + (3-1) = 5
    progressMax: maxAttempts + (maxAttempts - 1),
  });
  let attempts = 0;
  let run = true;
  return taskFunction({
    task,
    async func() {
      let loggedInTabId: number | null = null;
      /* eslint-disable no-await-in-loop */
      while (run) {
        try {
          if (attempts > 0) {
            task.status = 'Logging in again';
          } else {
            task.status = 'Logging in';
          }
          const response = await login({
            client,
            parentTaskId: task.id,
            keepTabOpen,
            closeOnErrors,
          });
          loggedInTabId = response.tabId;
          if (typeof response.checkLoginError !== 'undefined') {
            throw response.checkLoginError;
          }
          run = false;
        } catch (error) {
          if (error.type === 'LoginError' && error.code === 'WrongClient' && attempts + 1 < maxAttempts) {
            // Even if `closeOnErrors` is false, close the tab as we are about to make another.
            if (loggedInTabId !== null) {
              closeTab(loggedInTabId);
            }
            log.setCategory('login');
            log.showError(error, true);
            task.status = 'Logging out';
            await logout({ parentTaskId: task.id });
            run = true;
          } else {
            throw error;
          }
        }
        attempts++;
      }
      /* eslint-enable no-await-in-loop */
      return loggedInTabId;
    },
  });
}

export async function getPasswordExpiryDate(): Promise<string> {
  const doc = await getDocumentByAjax({ url: `${ZraDomain}/security/userprofile` });
  const expiryDate = getElementFromDocument<HTMLInputElement>(
    doc,
    '#userDto>div:nth-child(3)>div:nth-child(2)>div>div>input',
    'password expiry date',
  ).value;
  return expiryDate;
}
