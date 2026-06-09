import { Injectable, signal } from '@angular/core';

export interface User {
  name: string;
  email: string;
  roles: string[];
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  user = signal<User | null>(null);

  async checkSession() {
    try {
      const res = await fetch('/api/session');
      const data = await res.json();
      if (data.authenticated) {
        this.user.set(data.user);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async login(email: string, password: string): Promise<{ ok: boolean; error?: string; noAdmin?: boolean }> {
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        this.user.set(data.user);
        return { ok: true };
      }
      return { ok: false, error: data.error, noAdmin: data.noAdmin };
    } catch {
      return { ok: false, error: 'Error de conexión' };
    }
  }

  async logout() {
    await fetch('/api/logout', { method: 'POST' });
    this.user.set(null);
  }
}
