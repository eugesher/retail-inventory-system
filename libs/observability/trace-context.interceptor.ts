import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

// Stub interceptor: copies the active OTel span context into Pino's
// per-request bindings (`traceId`, `spanId`) so log lines and traces share
// IDs. Task-10 fills the body once `tracer.ts` boots a real `NodeSDK`. Until
// then this is a passthrough so app modules can already register it.
@Injectable()
export class TraceContextInterceptor implements NestInterceptor {
  public intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}
