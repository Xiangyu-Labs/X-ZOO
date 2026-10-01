/**
 * The shop's admin API as operations an AI agent (or a person at a terminal)
 * can find, read and run. Shared by `/mcp` and the `shop` CLI.
 */
export {
  DOMAIN_LABELS,
  describeOperation,
  findRoute,
  listOperations,
  searchOperations,
  type Operation,
  type OperationDetail,
} from './catalog';
export {
  callOperation,
  fillPath,
  OperationError,
  readBody,
  toSearch,
  uploadFile,
  type CallInput,
  type CallResult,
  type OpsClient,
  type UploadInput,
} from './call';
export { GUIDE } from './guide';
