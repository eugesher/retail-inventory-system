import { IJwtAccessPayload, IJwtRefreshPayload } from '@retail-inventory-system/contracts';

import { User } from '../../../domain/user.model';
import { IPasswordPort } from '../../ports/password.port';
import { IIssuedTokens, ITokenPort } from '../../ports/token.port';
import { IUserRepositoryPort } from '../../ports/user.repository.port';

export class InMemoryUserRepository implements IUserRepositoryPort {
  private byId = new Map<string, User>();

  public seed(user: User): void {
    this.byId.set(user.id, user);
  }

  public findByEmail(email: string): Promise<User | null> {
    const target = email.toLowerCase();
    for (const user of this.byId.values()) {
      if (user.email === target && user.isActive) return Promise.resolve(user);
    }
    return Promise.resolve(null);
  }

  public findById(id: string): Promise<User | null> {
    const user = this.byId.get(id);
    return Promise.resolve(user?.isActive ? user : null);
  }

  public save(user: User): Promise<User> {
    this.byId.set(user.id, user);
    return Promise.resolve(user);
  }

  public softDelete(id: string): Promise<void> {
    this.byId.delete(id);
    return Promise.resolve();
  }
}

// Minimal hasher: prefixes the plaintext so verify() is a string compare.
// Avoids the cost of real argon2 in unit tests.
export class FakeHasher implements IPasswordPort {
  public hash(plain: string): Promise<string> {
    return Promise.resolve(`hash:${plain}`);
  }
  public verify(hash: string, plain: string): Promise<boolean> {
    return Promise.resolve(hash === `hash:${plain}`);
  }
}

export class FakeTokenAdapter implements ITokenPort {
  public issuedAccess: Omit<IJwtAccessPayload, 'iat' | 'exp'>[] = [];
  public issuedRefresh: Omit<IJwtRefreshPayload, 'iat' | 'exp'>[] = [];
  public refreshFailures = new Set<string>();

  public issueAccessToken(payload: Omit<IJwtAccessPayload, 'iat' | 'exp'>): Promise<string> {
    this.issuedAccess.push(payload);
    return Promise.resolve(`access:${payload.sub}:${payload.jti}`);
  }
  public issueRefreshToken(payload: Omit<IJwtRefreshPayload, 'iat' | 'exp'>): Promise<string> {
    this.issuedRefresh.push(payload);
    return Promise.resolve(`refresh:${payload.sub}:${payload.jti}`);
  }
  public verifyRefresh(token: string): Promise<IJwtRefreshPayload> {
    if (this.refreshFailures.has(token)) {
      return Promise.reject(new Error('invalid'));
    }
    const match = /^refresh:([^:]+):([^:]+)$/.exec(token);
    if (!match) return Promise.reject(new Error('malformed'));
    return Promise.resolve({ sub: match[1], jti: match[2] });
  }
  public accessTokenExpiresInSeconds(): number {
    return 900;
  }

  public lastIssuedTokens(): IIssuedTokens {
    const access = this.issuedAccess[this.issuedAccess.length - 1];
    const refresh = this.issuedRefresh[this.issuedRefresh.length - 1];
    return {
      accessToken: `access:${access.sub}:${access.jti}`,
      refreshToken: `refresh:${refresh.sub}:${refresh.jti}`,
      refreshTokenJti: refresh.jti,
      expiresIn: this.accessTokenExpiresInSeconds(),
    };
  }
}
