import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';
import type { LoggerService } from '@nestjs/common';

/** Keeps framework messages outside the application log data plane. */
export class NestStructuredLogger implements LoggerService {
  public constructor(private readonly logger: StructuredApplicationLogger) {}

  public log(_message: unknown, ..._optionalParams: unknown[]): void {
    void _message;
    void _optionalParams;
    this.logger.info('NEST_RUNTIME_LOG');
  }

  public error(_message: unknown, ..._optionalParams: unknown[]): void {
    void _message;
    void _optionalParams;
    this.logger.error('NEST_RUNTIME_ERROR');
  }

  public warn(_message: unknown, ..._optionalParams: unknown[]): void {
    void _message;
    void _optionalParams;
    this.logger.warn('NEST_RUNTIME_WARNING');
  }

  public debug(_message: unknown, ..._optionalParams: unknown[]): void {
    void _message;
    void _optionalParams;
    this.logger.debug('NEST_RUNTIME_DEBUG');
  }

  public verbose(_message: unknown, ..._optionalParams: unknown[]): void {
    void _message;
    void _optionalParams;
    this.logger.debug('NEST_RUNTIME_VERBOSE');
  }

  public fatal(_message: unknown, ..._optionalParams: unknown[]): void {
    void _message;
    void _optionalParams;
    this.logger.error('NEST_RUNTIME_FATAL');
  }
}
