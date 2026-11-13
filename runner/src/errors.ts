export class RunnerError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'RunnerError'
    this.status = status
  }
}
