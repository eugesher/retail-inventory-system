import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

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
