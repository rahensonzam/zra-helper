import store from '@/store';
import createTask from '@/transitional/tasks';
import Papa from 'papaparse';
import { exportFormatCodes, taxTypes } from '../constants';
import { writeJson } from '../file_utils';
import { taskFunction, parallelTaskMap } from './utils';
import { createClientAction, ClientActionRunner } from './base';
import { getPendingLiabilityPage } from '../reports';
import { getAccountCodeTask } from '../tax_account_code';

/** Columns to get from the pending liabilities table */
const totalsColumns = [
  'principal',
  'interest',
  'penalty',
  'total',
];

/**
 * @typedef {Object.<string, string>} Totals
 * Totals with two decimal places. The possible totals are all the items in `totalsColumns`.
 */

/**
 * Generates an object with totals that are all one value.
 * @param {string[]} columns
 * @param {string} value
 * @returns {Totals}
 */
function generateTotals(columns, value) {
  const totals = {};
  for (const column of columns) {
    totals[column] = value;
  }
  return totals;
}

/**
 * Gets the pending liability totals of a tax type.
 * @param {import('../constants').Client} client
 * @param {import('./utils').TaxAccount} taxAccount
 * @param {number} parentTaskId
 * @returns {Promise<Totals|null>}
 */
async function getPendingLiabilities(client, taxAccount, parentTaskId) {
  const taxType = taxTypes[taxAccount.taxTypeId];

  const taxAccountTask = await createTask(store, {
    title: `Get ${taxType} totals`,
    parent: parentTaskId,
    progressMax: 2,
  });
  return taskFunction({
    task: taxAccountTask,
    async func() {
      taxAccountTask.status = 'Getting tax account code';
      const accountCode = await getAccountCodeTask({
        parentTaskId: taxAccountTask.id,
        accountName: taxAccount.accountName,
      });

      taxAccountTask.addStep('Extracting totals');
      const task = await createTask(store, {
        title: 'Extract totals',
        parent: taxAccountTask.id,
        progressMax: 2,
      });
      return taskFunction({
        task,
        async func() {
          task.status = 'Getting totals from first page';
          let response = await getPendingLiabilityPage({
            accountCode,
            taxTypeId: taxAccount.taxTypeId,
            page: 1,
            tpin: client.username,
          });

          if (response.numPages > 1) {
            task.addStep('More than one page found. Getting totals from last page');
            response = await getPendingLiabilityPage({
              accountCode,
              taxTypeId: taxAccount.taxTypeId,
              page: response.numPages,
              tpin: client.username,
            });
          }

          let totals;
          const { records } = response.parsedTable;
          if (records.length > 0) {
            const totalsRow = records[records.length - 1];
            // Make sure we are getting totals from the grand total row.
            if (totalsRow.srNo.toLowerCase() === 'grand total') {
              totals = {};
              for (const column of totalsColumns) {
                const cell = totalsRow[column];
                totals[column] = cell.replace(/\n\n/g, '');
              }
            } else {
              totals = null;
            }
          } else {
            totals = generateTotals(totalsColumns, '0');
          }

          return totals;
        },
      });
    },
  });
}

const GetAllPendingLiabilitiesClientAction = createClientAction({
  id: 'getAllPendingLiabilities',
  name: 'Get all pending liabilities',
  requiresTaxTypes: true,
  hasOutput: true,
  defaultOutputFormat: exportFormatCodes.CSV,
  outputFormats: [exportFormatCodes.CSV, exportFormatCodes.JSON],
  outputFormatter(clients, clientOutputs, format) {
    if (format === exportFormatCodes.CSV) {
      const rows = [];
      const columnOrder = totalsColumns;
      // Columns are: client identifier, ...totals, error
      const numberOfColumns = 2 + totalsColumns.length + 1;
      for (const client of clients) {
        let value = null;
        if (client.id in clientOutputs) {
          ({ value } = clientOutputs[client.id]);
        }
        const totalsObjects = value ? value.totals : null;
        let i = 0;
        for (const taxType of Object.values(taxTypes)) {
          let firstCol = '';
          if (i === 0) {
            firstCol = client.name ? client.name : `Client ${client.id}`;
          }
          const row = [firstCol, taxType];
          if (value && (taxType in totalsObjects)) {
            const totalsObject = totalsObjects[taxType];
            const totals = [];
            for (const column of columnOrder) {
              totals.push(totalsObject[column]);
            }
            row.push(...totals);
          } else {
            for (let j = 0; j < columnOrder.length; j++) {
              row.push('');
            }
            // Indicate that this tax type had an error
            if (value && (taxType in value.retrievalErrors)) {
              row.push('!');
            }
          }
          // Fill empty columns
          while (row.length < numberOfColumns) {
            row.push('');
          }
          rows.push(row);
          i++;
        }
      }
      // TODO: Make output options configurable by user
      return Papa.unparse(rows, {
        quotes: true,
      });
    }
    const json = {};
    for (const client of clients) {
      if (client.id in clientOutputs) {
        const output = clientOutputs[client.id];
        json[client.id] = {
          client: {
            id: client.id,
            name: client.name,
            username: client.username,
          },
          actionId: output.actionId,
          value: output.value,
          error: output.error,
        };
      }
    }
    return writeJson(json);
  },
});

GetAllPendingLiabilitiesClientAction.Runner = class extends ClientActionRunner {
  constructor(data) {
    super(data);
    this.storeProxy.actionId = GetAllPendingLiabilitiesClientAction.id;
  }

  async runInternal() {
    const { parentTask, client } = this.storeProxy;
    const taxAccounts = client.registeredTaxAccounts;

    /**
     * @typedef {Object} TotalsResponses
     * @property {Totals} totals
     * @property {Error} retrievalErrors
     */
    /** @type {Object.<string, TotalsResponses>} */
    const responses = await parallelTaskMap({
      task: parentTask,
      count: taxAccounts.length,
      async func(taxAccountKey, parentTaskId) {
        const taxAccount = taxAccounts[taxAccountKey];

        const response = {
          totals: null,
          retrievalErrors: [],
        };
        try {
          response.totals = await getPendingLiabilities(client, taxAccount, parentTaskId);
        } catch (error) {
          response.retrievalErrors = error;
        }
        return response;
      },
    });

    const output = {
      totals: {},
      retrievalErrors: {},
    };
    for (let i = 0; i < taxAccounts.length; i++) {
      const taxAccount = taxAccounts[i];
      const taxType = taxTypes[taxAccount.taxTypeId];
      const { totals, retrievalErrors } = responses[i];
      if (totals) {
        output.totals[taxType] = Object.assign({}, totals);
      } else {
        output.retrievalErrors[taxType] = retrievalErrors;
      }
    }
    this.storeProxy.output = output;
    const failedTaxTypes = Object.keys(output.retrievalErrors);
    if (failedTaxTypes.length > 0) {
      this.setRetryReason(`Failed to get some tax types: ${failedTaxTypes}`);
    }
  }
};

export default GetAllPendingLiabilitiesClientAction;
