import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';

import { AppModule } from './app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('API_GATEWAY_PORT', 3000);
  const useApiReference = configService.get<boolean>('api-gateway.use-api-reference');
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  if (useApiReference) {
    const documentConfig = new DocumentBuilder()
      .setTitle('Retail Inventory System')
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
}

void bootstrap().catch((err) => {
  console.error('Bootstrap failed', err);
  process.exit(1);
});
