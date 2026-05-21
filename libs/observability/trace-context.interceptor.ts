import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

// Passthrough placeholder. OTel auto-instrumentation already propagates the
// active span across the request flow; this interceptor remains a no-op
// so app modules can declare the import without churn.
@Injectable()
export class TraceContextInterceptor implements NestInterceptor {
  public intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}
