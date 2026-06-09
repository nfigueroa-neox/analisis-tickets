import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css',
})
export class LoginComponent {
  private auth = inject(AuthService);
  private router = inject(Router);

  email = '';
  password = '';
  error = '';
  isNoAdmin = false;
  loading = false;

  async doLogin() {
    const email = this.email.trim();
    const password = this.password;

    if (!email || !password) {
      this.error = 'Ingresa email y contraseña';
      this.isNoAdmin = false;
      return;
    }

    this.loading = true;
    this.error = '';
    this.isNoAdmin = false;

    const result = await this.auth.login(email, password);

    if (result.ok) {
      this.router.navigate(['/horas']);
    } else {
      this.error = result.noAdmin
        ? '⚠️ Usuario sin permisos de administrador. Solo usuarios ADMIN pueden acceder.'
        : result.error || 'Error al iniciar sesión';
      this.isNoAdmin = !!result.noAdmin;
      this.loading = false;
    }
  }
}
