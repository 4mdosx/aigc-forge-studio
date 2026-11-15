export class TrainerError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'TrainerError'
    this.status = status
  }
}
