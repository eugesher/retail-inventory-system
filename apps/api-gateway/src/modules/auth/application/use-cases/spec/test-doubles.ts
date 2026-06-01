import {
  IAuditLogEvent,
  IAuditLogPublisher,
  IJwtAccessPayload,
  IJwtRefreshPayload,
} from '@retail-inventory-system/contracts';

import { Customer, StaffUser } from '../../../domain';
import {
  ICustomerRepositoryPort,
  IIssuedTokens,
  IPasswordPort,
  IStaffUserRepositoryPort,
  ITokenPort,
} from '../../ports';

export class InMemoryStaffUserRepository implements IStaffUserRepositoryPort {
  private byId = new Map<string, StaffUser>();

  public seed(user: StaffUser): void {
    this.byId.set(user.id, user);
  }

  public findByEmail(email: string): Promise<StaffUser | null> {
    const target = email.toLowerCase();
    for (const user of this.byId.values()) {
      if (user.email === target && user.isActive) return Promise.resolve(user);
    }
    return Promise.resolve(null);
  }

  public findById(id: string): Promise<StaffUser | null> {
    const user = this.byId.get(id);
    return Promise.resolve(user?.isActive ? user : null);
  }

  public existsActiveById(id: string): Promise<boolean> {
    return Promise.resolve(this.byId.get(id)?.isActive ?? false);
  }

  public save(user: StaffUser): Promise<StaffUser> {
    this.byId.set(user.id, user);
    return Promise.resolve(user);
  }

  public softDelete(id: string): Promise<void> {
    this.byId.delete(id);
    return Promise.resolve();
  }
}

export class InMemoryCustomerRepository implements ICustomerRepositoryPort {
  private byId = new Map<string, Customer>();

  public seed(customer: Customer): void {
    this.byId.set(customer.id, customer);
  }

  public findByEmail(email: string): Promise<Customer | null> {
    const target = email.toLowerCase();
    for (const customer of this.byId.values()) {
      if (customer.email === target) return Promise.resolve(customer);
    }
    return Promise.resolve(null);
  }

  public findById(id: string): Promise<Customer | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  public existsActiveById(id: string): Promise<boolean> {
    return Promise.resolve(this.byId.get(id)?.isActive ?? false);
  }

  public save(customer: Customer): Promise<Customer> {
    this.byId.set(customer.id, customer);
    return Promise.resolve(customer);
  }
}

// Plaintext-prefixing fake — avoids real argon2's intentional cost in unit tests.
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

// Recording fake for IAuditLogPublisher — collects the published events so
// specs can assert event-name + payload shape per audit point.
export class FakeAuditLogPublisher implements IAuditLogPublisher {
  public readonly published: IAuditLogEvent[] = [];

  public publish(event: IAuditLogEvent): Promise<void> {
    this.published.push(event);
    return Promise.resolve();
  }
}
