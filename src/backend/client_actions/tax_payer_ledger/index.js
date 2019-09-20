import {
  getPagedData, parallelTaskMap, taskFunction, getClientIdentifier,
} from '@/backend/client_actions/utils';
import { taxTypes, exportFormatCodes, taxTypeNumericalCodes } from '@/backend/constants';
import { getTaxPayerLedgerPage, ledgerColumns } from '@/backend/reports';
import getAccountCodeTask from '@/backend/tax_account_code';
import store from '@/store';
import createTask from '@/transitional/tasks';
import {
  createClientAction,
  ClientActionRunner,
  createOutputFile,
  getInput,
} from '../base';
import moment from 'moment';
import { unparseCsv, writeJson } from '@/backend/file_utils';

/**
 * @typedef {Object} RunnerInput
 * @property {import('@/backend/constants').Date} [fromDate]
 * @property {import('@/backend/constants').Date} [toDate]
 * @property {import('@/backend/constants').TaxTypeNumericalCode[]} [taxTypeIds]
 * @property {Object.<string, number[]>} [pages]
 * Pages, stored by tax type ID, to get ledger records from.
 */

function outputFormatter({ output, format }) {
  if (format === exportFormatCodes.CSV) {
    const rows = [];
    const headers = ['taxTypeId', ...ledgerColumns];
    rows.push(headers);

    if (output !== null) {
      // TODO: Indicate output errors
      const numberOfColumns = headers.length;
      for (const taxTypeId of Object.keys(output)) {
        let i = 0;
        const records = output[taxTypeId];
        for (const record of records) {
          let firstCol = '';
          if (i === 0) {
            firstCol = taxTypeId;
          }
          const row = [firstCol];
          for (const col of ledgerColumns) {
            row.push(record[col]);
          }
          // Fill empty columns
          while (row.length < numberOfColumns) {
            row.push('');
          }
          rows.push(row);
          i++;
        }
      }
    }
    // TODO: Make output options configurable by user
    return unparseCsv(rows);
  }
  return writeJson(output);
}

function sanitizeDates(date) {
  return date.replace(/\//g, '-');
}

const TaxPayerLedgerClientAction = createClientAction({
  id: 'taxPayerLedger',
  name: 'Get records from tax payer ledger',
  requiresTaxTypes: true,
  defaultInput: () => ({
    fromDate: '01/01/2013',
    toDate: moment().format('DD/MM/YYYY'),
    taxTypeIds: taxTypeNumericalCodes,
  }),
  inputValidation: {
    taxTypeIds: 'required|taxTypeIds',
    fromDate: 'required|date_format:dd/MM/yyyy|before:toDate,true',
    toDate: 'required|date_format:dd/MM/yyyy|after:fromDate,true',
  },
  hasOutput: true,
  generateOutputFiles({ clients, outputs }) {
    const outputFiles = [];
    for (const client of clients) {
      if (!(client.id in outputs)) break;
      const output = outputs[client.id];
      /** @type {{input: RunnerInput}} */
      const { input } = output;
      const period = `${sanitizeDates(input.fromDate)}_${sanitizeDates(input.toDate)}`;
      const filename = `ledger_${client.username}_${period}`;
      /** @type {LedgerOutput | null} */
      const outputValue = output.value;
      outputFiles.push(createOutputFile({
        label: `${getClientIdentifier(client)} ledger records`,
        filename,
        formats: [exportFormatCodes.CSV, exportFormatCodes.JSON],
        value: outputValue,
        formatter: outputFormatter,
      }));
    }
    return createOutputFile({
      label: 'Ledger records for each client',
      wrapper: true,
      children: outputFiles,
    });
  },
});

/**
 * FIXME: Use TypeScript
 * @typedef LedgerFailures
 * @property {import('@/backend/constants').TaxTypeNumericalCode[]} taxTypes
 * @property {Object.<string, number[]>} pages Failed pages by tax type ID
 */

/**
 * @typedef {Object.<string, import('@/backend/reports').TaxPayerLedgerRecord[]>} LedgerOutput
 * Ledger records by tax type ID
 */

TaxPayerLedgerClientAction.Runner = class extends ClientActionRunner {
  /** @type {LedgerFailures} */
  failures = {
    taxTypes: [],
    pages: {},
  };

  constructor() {
    super(TaxPayerLedgerClientAction);
  }

  getInitialFailuresObj() {
    return {
      taxTypes: [],
      pages: {},
    };
  }

  async runInternal() {
    const { task: parentTask, client } = this.storeProxy;
    /** @type {{input: RunnerInput}} */
    const { input } = this.storeProxy;
    const { fromDate, toDate } = input;

    let taxAccounts = client.registeredTaxAccounts;

    const taxTypeIdsInput = getInput(input, 'taxTypeIds', { checkArrayLength: false });
    if (taxTypeIdsInput.exists) {
      taxAccounts = taxAccounts.filter(
        account => taxTypeIdsInput.value.includes(account.taxTypeId),
      );
    }

    // Get data for each tax account
    const taxTypeResponses = await parallelTaskMap({
      task: parentTask,
      list: taxAccounts,
      /**
       * @param {import('../utils').TaxAccount} taxAccount
       */
      async func(taxAccount, parentTaskId) {
        const { taxTypeId } = taxAccount;
        const taxTypeCode = taxTypes[taxTypeId];
        const taxAccountTask = await createTask(store, {
          title: `Get ${taxTypeCode} tax payer ledger`,
          parent: parentTaskId,
        });
        return taskFunction({
          task: taxAccountTask,
          async func() {
            taxAccountTask.status = 'Get tax account code';
            const accountCode = await getAccountCodeTask({
              parentTaskId: taxAccountTask.id,
              accountName: taxAccount.accountName,
              taxTypeId,
            });

            const task = await createTask(store, {
              title: 'Extract data from all pages of ledger',
              parent: taxAccountTask.id,
            });

            const getPageSubTask = (page, subTaskParentId) => ({
              title: `Extract data from page ${page} of the ledger`,
              parent: subTaskParentId,
              indeterminate: true,
            });

            const { value: pages } = getInput(input, `pages.${taxTypeId}`, { defaultValue: [] });

            taxAccountTask.status = 'Get data from all pages';
            const allResponses = await getPagedData({
              task,
              getPageSubTask,
              pages,
              getDataFunction: async (page) => {
                const reportPage = await getTaxPayerLedgerPage({
                  accountCode,
                  fromDate,
                  toDate,
                  page,
                  tpin: client.username,
                });
                return {
                  numPages: reportPage.numPages,
                  value: reportPage.parsedTable,
                };
              },
            });

            return allResponses;
          },
        });
      },
    });

    const output = {};
    for (const taxTypeResponse of taxTypeResponses) {
      const { taxTypeId } = taxTypeResponse.item;
      if (!('error' in taxTypeResponse)) {
        /** @type {import('@/backend/reports').TaxPayerLedgerRecord[]} */
        const records = [];
        for (const response of Object.values(taxTypeResponse.value)) {
          if (!('error' in response)) {
            records.push(...response.value.records);
          } else {
            if (!(taxTypeId in this.failures.pages)) {
              this.failures.pages[taxTypeId] = [];
            }
            this.failures.pages[taxTypeId].push(response.page);
          }
        }
        if (taxTypeId in this.failures.pages) {
          this.failures.taxTypeIds.push(taxTypeId);
        }
        output[taxTypeId] = records;
      } else {
        this.failures.taxTypeIds.push(taxTypeId);
      }
    }

    // FIXME: Merge records from retry with previous try
    this.setOutput(output);
  }

  checkIfAnyPagesFailed() {
    return Object.keys(this.failures.pages).length > 0;
  }

  checkIfAnythingFailed() {
    return this.failures.taxTypeIds.length > 0 || this.checkIfAnyPagesFailed();
  }

  getRetryReasons() {
    const reasons = super.getRetryReasons();
    const failedTaxTypes = this.failures.taxTypeIds.map(id => taxTypes[id]);
    reasons.push(`Failed to get some ledger records from the following tax accounts: [ ${failedTaxTypes.join(', ')} ].`);
    return reasons;
  }

  getRetryInput() {
    /** @type {RunnerInput} */
    const retryInput = {};
    if (this.failures.taxTypeIds.length > 0) {
      retryInput.taxTypeIds = this.failures.taxTypeIds;
    }
    if (this.checkIfAnyPagesFailed()) {
      retryInput.pages = this.failures.pages;
    }
    return retryInput;
  }
};
export default TaxPayerLedgerClientAction;
