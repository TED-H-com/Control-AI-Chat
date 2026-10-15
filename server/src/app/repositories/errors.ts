export class RepositoryError extends Error {
  constructor(readonly code:'NOT_FOUND'|'VALIDATION_FAILED'|'CONFLICT'|'PRECONDITION_FAILED'|'CONTEXT_WINDOW_EXCEEDED'|'NOT_IMPLEMENTED',message:string){super(message);this.name='RepositoryError'}
}
