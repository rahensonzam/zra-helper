import { TableError, ZraError } from '../../errors';
import { getElementFromDocument } from './elements';

/**
 * Gets error message from page if it exists
 * @param {Document} document
 * @returns {ZraError|null}
 */
export function getZraError(document) {
  // eslint-disable-next-line max-len
  const errorTable = document.querySelector('#maincontainer>tbody>tr:nth-child(4)>td:nth-child(3)>form>div>table>tbody>tr>td>table');
  if (errorTable !== null) {
    const errorTableHeader = errorTable.querySelector('tbody>tr.tdborder>td');
    if (errorTableHeader !== null && errorTableHeader.innerText.includes('An Error has occurred')) {
      const error = errorTable.querySelector('tbody>tr:nth-child(2)>td');
      if (error !== null) {
        return new ZraError(`${errorTableHeader.innerText.trim()}. ${error.innerText}`, null, {
          error: error.innerText,
        });
      }
    }
  }
  return null;
}

/**
 * @typedef {Object.<string, string>} ParsedTableRecord
 * Object representing a single row whose keys are column headers and whose values are the corresponding cell values.
 */

/**
 * Parses ZRA tables and returns the records.
 * @param {Object} options
 * @param {Document|Element} options.root Document to get records from
 * @param {string[]} options.headers Column headers
 * @param {string} options.recordSelector Selector of a single table data row. This shouldn't match any header rows.
 * @returns {ParsedTableRecord[]}
 */
export function parseTable({ root, headers, recordSelector }) {
  const records = [];
  const recordElements = root.querySelectorAll(recordSelector);
  for (const recordElement of recordElements) {
    const row = {};
    const columns = recordElement.querySelectorAll('td');
    for (let index = 0; index < columns.length; index++) {
      const column = columns[index];
      let value = column.innerText.trim();
      const link = column.querySelector('a');
      if (link) {
        const onclick = link.getAttribute('onclick');
        if (onclick) {
          value = {
            innerText: value,
            onclick,
          };
        }
      }
      row[headers[index]] = value;
    }
    records.push(row);
  }
  return records;
}

/**
 * @typedef ParsedTable
 * @property {ParsedTableRecord[]} records Array of records
 * @property {number} currentPage The current page
 * @property {number} numPages The total number of pages
 */

/**
 * Parses ZRA tables and returns the records, current page and number of pages.
 * @param {Object} options
 * @param {Document|Element} options.root Document to get elements from
 * @param {string[]} options.headers Column headers
 * @param {string} options.tableInfoSelector
 * Selector of the element that contains information about the table such as the current page.
 * @param {string} options.recordSelector Selector of a single table data row. This shouldn't match header rows.
 * @param {string} options.noRecordsString String that will exist when there are no records
 * @returns {Promise.<ParsedTable>}
 */
export function parseTableAdvanced({
  root, headers, tableInfoSelector, recordSelector, noRecordsString = 'No Records Found',
}) {
  return new Promise((resolve, reject) => {
    const tableInfoElement = getElementFromDocument(root, tableInfoSelector, 'table info');
    const tableInfo = tableInfoElement.innerText;
    if (!tableInfo.includes(noRecordsString)) {
      const tableInfoMatches = tableInfo.match(/Current Page : (\d+) \/ (\d+)/);
      const currentPage = tableInfoMatches[1];
      const numPages = tableInfoMatches[2];
      const records = parseTable({ root, headers, recordSelector });
      resolve({
        records,
        currentPage: Number(currentPage),
        numPages: Number(numPages),
      });
      return;
    }
    reject(new TableError('No records found in table.', 'NoRecordsFound'));
  });
}
