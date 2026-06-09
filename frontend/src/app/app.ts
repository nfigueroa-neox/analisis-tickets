import { Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { AuthService } from './services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected router = inject(Router);
  protected auth = inject(AuthService);

  isLoginPage(): boolean {
    return this.router.url === '/login' || this.router.url === '/';
  }

  async logout() {
    await this.auth.logout();
    this.router.navigate(['/login']);
  }

  goTo(section: string) {
    this.router.navigate([section]);
  }
}
