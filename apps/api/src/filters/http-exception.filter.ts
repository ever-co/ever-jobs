import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { recordHttpRequest } from '../metrics/http-metrics';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Global exception filter returning structured JSON errors.
 * Provides structured JSON error responses with validation details.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  // Optional so the filter still works in apps/tests that do not load the
  // metrics module.
  constructor(@Optional() private readonly metricsService?: MetricsService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    // GraphQL requests don't have an Express request/response — let Apollo
    // handle errors natively by re-throwing.
    const contextType = host.getType<string>();
    if (contextType === 'graphql') {
      if (exception instanceof Error) {
        throw exception;
      }
      throw new Error(String(exception));
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorPayload: Record<string, any> = {
      error: 'Internal Server Error',
      detail: 'An unexpected error occurred',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        errorPayload = {
          error: exceptionResponse,
          detail: exceptionResponse,
        };
      } else if (typeof exceptionResponse === 'object') {
        const res = exceptionResponse as Record<string, any>;

        // Handle class-validator errors (NestJS validation pipe)
        if (Array.isArray(res.message)) {
          errorPayload = {
            error: 'Validation Error',
            detail: 'One or more parameters are invalid',
            validationErrors: res.message.map((msg: string) => ({
              message: msg,
              suggestion: 'Check the API documentation for valid parameter values',
            })),
          };
        } else {
          errorPayload = {
            error: res.error || res.message || 'Error',
            detail: res.message || res.error || 'Unknown error',
          };
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled exception: ${exception.message}`,
        exception.stack,
      );
      errorPayload = {
        error: 'Internal Server Error',
        detail: exception.message,
      };
    }

    // Log more detail for validation (Bad Request) errors
    const logLevel = status >= 500 ? 'error' : 'warn';
    this.logger[logLevel](
      `✕ ${request.method} ${request.url} ${Date.now()}ms [${request.headers?.['x-request-id'] ?? 'no-id'}] ${errorPayload.error}`,
    );
    if (status === 400 && errorPayload.validationErrors) {
      this.logger.warn(
        `Validation errors: ${JSON.stringify(errorPayload.validationErrors)}`,
      );
      this.logger.warn(
        `Request body: ${JSON.stringify(request.body)}`,
      );
    }

    // Guards (API key 401, rate limit 429) reject before any interceptor
    // runs, so this is the only place those requests can be counted. A
    // request the interceptor already recorded is skipped.
    if (this.metricsService) {
      try {
        recordHttpRequest(this.metricsService, request, status);
      } catch (err) {
        this.logger.warn(`Could not record HTTP metrics: ${String(err)}`);
      }
    }

    response.status(status).json({
      ...errorPayload,
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
