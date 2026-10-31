// Unit tests supply storage/socket seams; worker.test.ts runs the real DO in workerd.
export class DurableObject {
  constructor(protected ctx: any, protected env: any) {}
}
