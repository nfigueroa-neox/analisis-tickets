import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export async function authGuard(): Promise<boolean> {
  const auth = inject(AuthService);
  const router = inject(Router);
  const ok = await auth.checkSession();
  if (!ok) {
    router.navigate(['/login']);
    return false;
  }
  return true;
}
