import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';

import { AppModule } from './app';
import { ConfigPropertyPathEnum } from '@retail-inventory/config';

((): void => {
  const logger = new Logger('ApiGatewayBootstrap');

  void (async (): Promise<void> => {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });

    const configService = app.get(ConfigService);
    const apiPrefix = configService.get<string>('API_GATEWAY_PREFIX')!;
    const port = configService.get<number>('API_GATEWAY_PORT')!;
    const useApiReference = configService.get<boolean>(
      ConfigPropertyPathEnum.API_GATEWAY_USE_API_REFERENCE,
    );

    app.setGlobalPrefix(apiPrefix);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );

    if (useApiReference) {
      const documentConfig = new DocumentBuilder()
        .setTitle('Retail Inventory System API Gateway')
        .addServer(`http://localhost:${port}`, 'Local')
        .build();
      const document = SwaggerModule.createDocument(app, documentConfig);

      app.use(
        '/reference',
        apiReference({
          content: document,
        }),
      );
    }

    await app.listen(port);

    logger.log(`API Gateway is running on port: ${port}`);
  })().catch((e: Error) => {
    logger.error(e.message, e.stack);

    process.exit(1);
  });
})();
