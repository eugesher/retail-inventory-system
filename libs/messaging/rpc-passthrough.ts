import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

// Send an RPC and rethrow a rejection wrapped in `RpcException(err)` so the upstream
// `{ statusCode, message, code, details }` reaches the next hop verbatim.
//
// `firstValueFrom` materializes the cold `send()` Observable; on rejection the
// serving microservice's RPC filter has already shaped the wire error (e.g. an
// inventory `INVENTORY_OUT_OF_STOCK` 409 carrying `details.available`). Without the
// `RpcException` wrap an uncaught plain-object rejection would be re-wrapped lossily
// by Nest's transport layer — the typed `code` + `details` would be dropped. Used by
// an INTERMEDIATE adapter (one service relaying a second service's RPC, e.g. the
// retail→inventory reservation seam, ADR-030) whose own RPC filter only catches its
// domain exception, so this `RpcException` passes straight through unchanged.
export async function sendPreservingRpcError<TResult, TPayload>(
  client: ClientProxy,
  routingKey: string,
  payload: TPayload,
): Promise<TResult> {
  try {
    return await firstValueFrom(client.send<TResult, TPayload>(routingKey, payload));
  } catch (err) {
    throw new RpcException(err as object);
  }
}
