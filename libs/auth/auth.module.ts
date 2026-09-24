import { DynamicModule, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { PermissionsGuard } from './guards/permissions.guard';
import { RolesGuard } from './guards/roles.guard';

export interface IAuthModuleOptions {
  imports?: DynamicModule['imports'];
  providers?: Provider[];
  exports?: DynamicModule['exports'];
}

@Module({})
export class AuthModule {
  public static forRootAsync(options: IAuthModuleOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.registerAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => ({
            secret: configService.get<string>('JWT_ACCESS_SECRET'),
            signOptions: {
              expiresIn: configService.get<string>(
                'JWT_ACCESS_EXPIRES_IN',
              ) as JwtSignOptions['expiresIn'],
            },
          }),
        }),
        ...(options.imports ?? []),
      ],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        PermissionsGuard,
        ...(options.providers ?? []),
      ],
      exports: [
        JwtModule,
        PassportModule,
        JwtAuthGuard,
        RolesGuard,
        PermissionsGuard,
        ...(options.exports ?? []),
      ],
    };
  }
}
