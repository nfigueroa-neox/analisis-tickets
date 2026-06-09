import { Routes } from '@angular/router';
import { LoginComponent } from './pages/login/login.component';
import { HorasComponent } from './pages/horas/horas.component';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: '/login', pathMatch: 'full' },
  { path: 'login', component: LoginComponent },
  { path: 'horas', component: HorasComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: '/login' },
];
