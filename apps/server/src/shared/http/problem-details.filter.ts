import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

interface ValidationErrorItem {
  path: string;
  message: string;
}

/** RFC 9457 application/problem+json for every error the API emits (§9). */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail: string | undefined;
    let errors: ValidationErrorItem[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        title = body;
      } else if (typeof body === 'object' && body !== null) {
        const rec = body as Record<string, unknown>;
        title = typeof rec.error === 'string' ? rec.error : typeof rec.message === 'string' ? rec.message : exception.message;
        if (typeof rec.message === 'string' && typeof rec.error === 'string') {
          detail = rec.message;
        }
        if (Array.isArray(rec.errors)) {
          errors = rec.errors as ValidationErrorItem[];
        }
      }
    } else if (exception instanceof Error) {
      detail = exception.message;
    }

    response
      .status(status)
      .type('application/problem+json')
      .json({
        type: `https://httpstatuses.io/${status}`,
        title,
        status,
        ...(detail ? { detail } : {}),
        ...(errors ? { errors } : {}),
      });
  }
}
