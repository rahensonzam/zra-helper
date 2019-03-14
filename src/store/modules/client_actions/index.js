import Vue from 'vue';
import store from '@/store';
import log from '@/transitional/log';
import createTask from '@/transitional/tasks';
import { taskStates } from '@/store/modules/tasks';
import { MissingTaxTypesError } from '@/backend/errors';
import { robustLogin, logout } from '@/backend/client_actions/user';
import { featuresSupportedByBrowsers, browserCodes } from '@/backend/constants';
import { getCurrentBrowser } from '@/utils';
import notify from '@/backend/notify';
import { closeTab } from '@/backend/utils';
import { taskFunction } from '@/backend/client_actions/utils';

/**
 * @typedef {import('vuex').ActionContext} VuexActionContext
 * @typedef {import('@/backend/constants').Client} Client
 * @typedef {import('@/backend/client_actions/base').ClientActionRunner} ActionInstance
 * A single instance of a client action runner. New instances are created each run allowing
 * the outputs from each run to be stored and displayed.
 * @typedef {import('@/backend/client_actions/base').ClientActionObject} ActionObject
 */

/**
 * @typedef {Object} ActionRun
 * Contains all the client action instances from a single run of the extension.
 * @property {Object.<string, string[]>} instancesByActionId
 * IDs of instances from this run grouped by action ID. Instances are stored by action ID to make
 * it easier to combine all outputs from all clients of a single action into a single output.
 */

/**
 * @typedef {Object} ClientActionFailure
 * @property {number} clientId
 * @property {string} actionId
 * @property {Error|import('@/backend/errors').ExtendedError} [error]
 */

/**
 * @typedef {Object} State
 * @property {Object.<string, ActionObject>} actions Client actions stored by IDs.
 * @property {Object.<string, ActionInstance>} instances
 * Client action runner instances stored by instance ID.
 * @property {ActionRun[]} runs Action runs stored by run IDs.
 * @property {number} currentRunId Which run the program is currently on.
 */

/**
 * @typedef {Object} ClientActionOutput
 * @property {string} actionId
 * @property {number} clientId
 * @property {Object} [value]
 * @property {Error|null} [error]
 */

/**
 * @typedef {Object.<number, ClientActionOutput>} ClientActionOutputs
 * Client action runner outputs grouped by client ID.
 */

let lastInstanceId = 0;

/** @type {import('vuex').Module<State>} */
const module = {
  namespaced: true,
  state: {
    actions: {},
    instances: {},
    runs: [],
    currentRunId: null,
  },
  getters: {
    getActionById: state => id => state.actions[id],
    getInstanceById: state => id => state.instances[id],
    getRunById: state => id => state.runs[id],
    currentRun: state => state.runs[state.currentRunId],
    /**
     * Gets the IDs of all the actions in the specified run.
     * @returns {(runId: string) => string[]} IDs of the actions in run.
     */
    getAllActionsInRun: (_state, getters) => (runId) => {
      /** @type {ActionRun} */
      const run = getters.getRunById(runId);
      return Object.keys(run.instancesByActionId);
    },
    getBrowsersActionSupports: (_, getters) => (id) => {
      const action = getters.getActionById(id);
      const supportedBrowsers = [];
      for (const browserCode of Object.values(browserCodes)) {
        const featuresSupportedByBrowser = featuresSupportedByBrowsers[browserCode];
        let allSupported = true;
        for (const requiredFeature of action.requiredFeatures) {
          if (!featuresSupportedByBrowser.includes(requiredFeature)) {
            allSupported = false;
            break;
          }
        }
        if (allSupported) {
          supportedBrowsers.push(browserCode);
        }
      }
      return supportedBrowsers;
    },
    actionSupportsCurrentBrowser: (_, getters) => (id) => {
      const action = getters.getActionById(id);
      const featuresSupportedByCurrentBrowser = featuresSupportedByBrowsers[getCurrentBrowser()];
      for (const requiredFeature of action.requiredFeatures) {
        if (!featuresSupportedByCurrentBrowser.includes(requiredFeature)) {
          return false;
        }
      }
      return true;
    },
    running: (_state, _getters, _rootState, rootGetters) => {
      const rootTask = rootGetters['tasks/rootTask'];
      if (rootTask) {
        return !rootTask.complete;
      }
      return false;
    },
    /**
     * Gets all the action instances that should be retried.
     * @returns {ClientActionFailure[]}
     */
    retryableFailures(_state, getters) {
      const failures = [];
      /** @type {{currentRun: ActionRun}} */
      const { currentRun } = getters;
      if (currentRun) {
        for (const instanceIds of Object.values(currentRun.instancesByActionId)) {
          for (const instanceId of instanceIds) {
            /** @type {ActionInstance} */
            const instance = getters.getInstanceById(instanceId);
            if (instance.shouldRetry()) {
              failures.push({
                clientId: instance.client.id,
                actionId: instance.action.id,
                error: instance.error,
              });
            }
          }
        }
      }
      return failures;
    },
    retryableFailuresByClient(_state, getters) {
      const clientFailures = {};
      for (const failure of getters.retryableFailures) {
        const { clientId } = failure;
        if (!(clientId in clientFailures)) {
          Vue.set(clientFailures, clientId, []);
        }
        clientFailures[clientId].push(failure);
      }
      return clientFailures;
    },
    anyRetryableFailures(_state, getters) {
      return getters.retryableFailures.length > 0;
    },
    /**
     * Gets the outputs of all client action runner instances whose action IDs match the one
     * specified.
     * @returns {(actionId: string) => ClientActionOutputs}
     */
    getOutputsOfAction: (_state, getters) => (actionId) => {
      /** @type {ClientActionOutputs} */
      const outputs = {};
      /** @type {{ currentRun: ActionRun }} */
      const { currentRun } = getters;
      if (currentRun) {
        const instanceIds = currentRun.instancesByActionId[actionId];
        for (const instanceId of instanceIds) {
          /** @type {ActionInstance} */
          const instance = getters.getInstanceById(instanceId);
          // TODO: Don't add so much to the output
          outputs[instance.client.id] = {
            actionId,
            clientId: instance.client.id,
            value: instance.output,
            error: instance.error,
          };
        }
      }
      return outputs;
    },
  },
  mutations: {
    /**
     * Adds a new client action.
     * @param {ActionObject} payload
     */
    add(state, payload) {
      Vue.set(state.actions, payload.id, payload);
    },
    /**
     * Initializes a new program run. Each run can have different actions and outputs.
     * @see {@link ActionRun}
     * @returns {number} The ID of the newly started run.
     */
    startNewRun(state) {
      const runsLength = state.runs.push({
        instancesByActionId: {},
      });
      const runId = runsLength - 1;
      state.currentRunId = runId;
      return runId;
    },
    /**
     * Adds a newly created action runner instance to the current run.
     * @param {ActionInstance} instance
     */
    addNewInstance(state, instance) {
      // Generate a unique instance ID and add instance to the store under that ID.
      const instanceId = String(lastInstanceId);
      lastInstanceId++;
      state.instances[instanceId] = instance;
      Vue.set(state.instances, instanceId, instance);

      // Add the instance to the current run.
      const currentRun = state.runs[state.currentRunId];
      const actionId = instance.action.id;
      if (!(actionId in currentRun.instancesByActionId)) {
        Vue.set(currentRun.instancesByActionId, actionId, []);
      }
      currentRun.instancesByActionId[actionId].push(instanceId);
    },
  },
  actions: {
    /**
     * Adds a new client action.
     * @param {VuexActionContext} context
     * @param {ActionObject} payload
     */
    async add({ commit }, payload) {
      commit('add', payload);
    },
    /**
     * Runs an action on a single client.
     * @param {VuexActionContext} context
     * @param {Object} payload
     * @param {ActionInstance} payload.instance
     * @param {Client} payload.client
     * @param {import('@/transitional/tasks').TaskObject} payload.mainTask
     * @param {boolean} payload.isSingleAction
     * Whether this is the only action running on this client
     * @param {number} payload.loggedInTabId ID of the logged in tab.
     */
    async runActionOnClient(_context, {
      instance,
      client,
      mainTask,
      isSingleAction,
      loggedInTabId,
    }) {
      /** @type {ActionObject} */
      const clientAction = instance.action;

      const task = await createTask(store, { title: clientAction.name, parent: mainTask.id });
      let taskHasError = false;
      try {
        await taskFunction({
          task,
          setState: false,
          async func() {
            if (!(clientAction.requiresTaxTypes && client.taxTypes === null)) {
              log.setCategory(clientAction.logCategory);

              await instance.run({
                parentTask: task,
                loggedInTabId,
              });
              if (task.state === taskStates.ERROR) {
                taskHasError = true;
              }
            } else {
              // eslint-disable-next-line max-len
              throw new MissingTaxTypesError('Missing tax types. This was probably due to an error when retrieving them from the taxpayer profile.');
            }
          },
        });
      } catch (error) {
        log.setCategory(clientAction.logCategory);
        log.showError(error);
        if (isSingleAction) {
          // If this is the only action being run on this client,
          // show any errors produced by it on the main task.
          mainTask.setError(error);
        } else {
          taskHasError = true;
        }
        instance.error = error;
      } finally {
        if (taskHasError) {
          if (isSingleAction) {
            // If this is the only action being run on this client,
            // show any errors produced by it on the main task.
            mainTask.state = taskStates.ERROR;
          } else {
            // Show a warning on the main task to indicate that one of the actions failed.
            mainTask.state = taskStates.WARNING;
          }
        }
      }
    },
    /**
     * Runs several actions in parallel on a single client.
     * @param {VuexActionContext} context
     * @param {Object} payload
     * @param {Client} payload.client
     * @param {string[]} payload.actionIds
     * @param {number} payload.parentTaskId
     */
    async runActionsOnClient({
      rootState,
      commit,
      getters,
      dispatch,
    }, { client, actionIds, parentTaskId }) {
      const isSingleAction = actionIds.length === 1;
      let singleAction = null;

      const clientIdentifier = client.name ? client.name : `Client ${client.id}`;
      let taskTitle = clientIdentifier;
      if (isSingleAction) {
        singleAction = getters.getActionById(actionIds[0]);
        // If there is only one action, include it's name in the task's name.
        taskTitle = `${clientIdentifier}: ${singleAction.name}`;
      }

      const mainTask = await createTask(store, {
        title: taskTitle,
        unknownMaxProgress: false,
        progressMax: 2 + actionIds.length,
        sequential: isSingleAction,
        parent: parentTaskId,
      });

      /** @type {ActionObject[]} */
      const actions = actionIds.map(id => getters.getActionById(id));

      // Initialize all client action runner instances.
      const instances = [];
      for (const action of actions) {
        const ClientActionRunner = action.runner;
        const instance = new ClientActionRunner();
        const clientActionConfig = rootState.config.actions[action.id];
        instance.init({ client, config: clientActionConfig });
        commit('addNewInstance', instance);
        instances.push(instance);
      }

      let loggedInTabId = null;
      let loggedOut = false;
      let anyActionsNeedLoggedInTab = false;
      // TODO: Reduce complexity. Move some of it into separate functions, it's hard to read.
      try {
        await taskFunction({
          task: mainTask,
          setState: false,
          async func() {
            try {
              try {
                // Check if any of the actions require something
                const actionsThatRequire = {
                  loggedInTab: [],
                  taxTypes: [],
                };
                for (const action of actions) {
                  if (action.usesLoggedInTab) {
                    actionsThatRequire.loggedInTab.push(action.id);
                  }
                  if (action.requiresTaxTypes) {
                    actionsThatRequire.taxTypes.push(action.id);
                  }
                }

                anyActionsNeedLoggedInTab = actionsThatRequire.loggedInTab.length > 0;
                const anyActionsRequireTaxTypes = actionsThatRequire.taxTypes.length > 0;

                // If any actions require tax types, an extra task will be added to retrieve them.
                if (anyActionsRequireTaxTypes) {
                  mainTask.progressMax += 1;
                }

                mainTask.status = 'Logging in';
                loggedInTabId = await robustLogin({
                  client,
                  parentTaskId: mainTask.id,
                  maxAttempts: rootState.config.maxLoginAttempts,
                  keepTabOpen: anyActionsNeedLoggedInTab,
                });

                // Get tax types if any actions require them
                if (anyActionsRequireTaxTypes) {
                  mainTask.status = 'Getting tax types';
                  try {
                    await dispatch('clients/getTaxTypes', {
                      id: client.id,
                      parentTaskId: mainTask.id,
                      loggedInTabId,
                    }, { root: true });
                  } catch (error) {
                    // if all actions require tax types
                    if (actionsThatRequire.taxTypes.length === actionIds.length) {
                      throw error;
                    } else {
                      // Ignore error if not all tasks require tax types
                    }
                  }
                }

                // Run actions in parallel
                if (!isSingleAction) {
                  mainTask.status = 'Running actions';
                } else {
                  mainTask.status = singleAction.name;
                }
                const promises = [];
                for (const instance of instances) {
                  promises.push(dispatch('runActionOnClient', {
                    instance,
                    client,
                    mainTask,
                    isSingleAction,
                    loggedInTabId,
                  }));
                }
                await Promise.all(promises);
              } catch (error) {
                for (const instance of instances) {
                  instance.error = error;
                }
                throw error;
              }

              mainTask.status = 'Logging out';
              await logout({
                parentTaskId: mainTask.id,
                loggedInTabId: anyActionsNeedLoggedInTab ? loggedInTabId : null,
              });
              loggedOut = true;

              if (mainTask.state !== taskStates.ERROR && mainTask.state !== taskStates.WARNING) {
                if (mainTask.childStateCounts[taskStates.WARNING] > 0) {
                  mainTask.state = taskStates.WARNING;
                } else {
                  mainTask.state = taskStates.SUCCESS;
                }
              }
            } catch (error) {
              // If an action asked to keep the logged in tab open and logout didn't complete
              // then the tab still needs to be closed.
              if (anyActionsNeedLoggedInTab && !loggedOut && loggedInTabId !== null) {
                // TODO: Catch tab close errors
                closeTab(loggedInTabId);
              }
              throw error;
            }
          },
        });
      } catch (error) {
        log.setCategory(clientIdentifier);
        log.showError(error);
      }
    },
    /**
     * @callback GetClientsActionIds Gets the IDs of the actions to run on a client.
     * @param {Client} client
     * @return {number[]} The IDs of the actions
     */
    /**
     * Main program that runs actions on clients. The actions to run are decided on a per-client
     * basis using the `getClientsActionIds` parameter.
     *
     * A root task is wrapped around each client and a notification is sent once all are complete.
     * @param {VuexActionContext} context
     * @param {Object} payload
     * @param {ClientActionId[]} payload.actionIds
     * @param {number[]} payload.clientIds
     * @param {GetClientsActionIds} payload.getClientsActionIds
     * Function that decides the actions to run on each client.
     */
    async run({
      rootState,
      rootGetters,
      commit,
      dispatch,
    }, {
      clientIds,
      getClientsActionIds,
    }) {
      const clients = clientIds.map(id => rootGetters['clients/getClientById'](id));
      if (clients.length > 0) {
        commit('startNewRun');

        if (rootState.config.zraLiteMode) {
          dispatch('setZraLiteMode', true, { root: true });
        }

        const rootTask = await createTask(store, {
          title: 'Run actions on clients',
          progressMax: clients.length,
          unknownMaxProgress: false,
          sequential: true,
        });
        await dispatch('tasks/setRootTask', rootTask.id, { root: true });
        try {
          await taskFunction({
            task: rootTask,
            catchErrors: true,
            setStateBasedOnChildren: true,
            async func() {
              /* eslint-disable no-await-in-loop */
              for (const client of clients) {
                rootTask.status = client.name;
                // TODO: Consider checking if a tab has been closed prematurely all the time.
                // Currently, only tabLoaded checks for this.
                const actionIds = getClientsActionIds(client);
                await dispatch('runActionsOnClient', { client, actionIds, parentTaskId: rootTask.id });
              }
              /* eslint-enable no-await-in-loop */
            },
          });
        } finally {
          if (rootState.config.sendNotifications) {
            notify({
              title: 'All tasks complete',
              message: `Finished running ${clients.length} client(s)`,
            });
          }
          if (rootState.config.zraLiteMode) {
            dispatch('setZraLiteMode', false, { root: true });
          }
        }
      } else {
        log.setCategory('clientAction');
        log.showError('No clients found');
      }
    },
    /**
     * Runs the passed actions on all clients.
     * @param {VuexActionContext} context
     * @param {Object} payload
     * @param {number[]} actionIds
     * @param {number[]} clientIds
     */
    async runSelectedActionsOnAllClients({ dispatch }, { actionIds, clientIds }) {
      await dispatch('run', {
        clientIds,
        getClientsActionIds: () => actionIds,
      });
    },
    /**
     * Re-runs all the actions that failed on the clients they failed on.
     * @param {VuexActionContext} context
     */
    async retryFailures({ getters, dispatch }) {
      // Use a copy of the failures as they are reset on each run.
      const retryableFailuresByClient = Object.assign({}, getters.retryableFailuresByClient);
      await dispatch('run', {
        clientIds: Object.keys(retryableFailuresByClient),
        getClientsActionIds(client) {
          return retryableFailuresByClient[client.id].map(failure => failure.actionId);
        },
      });
    },
  },
};
export default module;
