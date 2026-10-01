/**
 * The domain kernel: the primitives every domain is built from.
 *
 * Changed deliberately and rarely — every domain copies these patterns, and a
 * fork of `Money` or of `withTx` would be a disaster. A domain that needs
 * something here asks for it rather than growing its own.
 */
export * from './clock';
export * from './context';
export * from './error-summary';
export * from './errors';
export * from './ids';
export * from './logger';
export * from './money';
export * from './pg-errors';
export * from './queue';
export * from './rate-limit';
export * from './storage';
export * from './tx';
export {
  listUnresolvedJobs,
  recordFailedJob,
  resolveFailedJob,
  type FailedJobInput,
} from './failed-jobs.repo';
export {
  allConfigGroups,
  createConfigService,
  defineConfigGroup,
  getConfigGroup,
  memoryConfigCache,
  pruneUnknownKeys,
  resetConfigRegistry,
  type ConfigCache,
  type ConfigFieldType,
  type ConfigFieldUi,
  type ConfigGroupDef,
  type ConfigService,
} from './config-registry';
