import { Component, ElementRef, inject, ViewChild, afterNextRender } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Chart, registerables } from 'chart.js';
import { ApiService, HoursResponse, TicketDetail, User } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

Chart.register(...registerables);

const COMPANY_PALETTE = [
  '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac',
  '#86bcf2','#f8ac5c','#f1787c','#9ed9cc','#7ec86f','#f3da6b','#ca9ec7','#fdb9c0','#b5977a','#d0c4c0',
  '#5fa2ce','#e9833c','#e76263','#80bfb5','#64b156','#e6c848','#b888a9','#fca6b0','#a5836c','#c8bdb9'
];

@Component({
  selector: 'app-horas',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './horas.component.html',
  styleUrl: './horas.component.css',
})
export class HorasComponent {
  private api = inject(ApiService);
  auth = inject(AuthService);

  @ViewChild('chartCompanyCanvas') chartCompanyCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('chartPeriodCanvas') chartPeriodCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('chartPriorityCanvas') chartPriorityCanvas!: ElementRef<HTMLCanvasElement>;

  users: User[] = [];
  companies: string[] = [];
  selectedUser = '';
  selectedCompany = 'todas';
  startDate = '';
  endDate = '';
  loading = false;
  resultsVisible = false;

  data: HoursResponse | null = null;
  selectedCompanyFilter: string | null = null;
  companyColorMap: Record<string, string> = {};
  periodType = 'day';

  private chartCompany: Chart | null = null;
  private chartPeriod: Chart | null = null;
  private chartPriority: Chart | null = null;

  // Modal
  modalActive = false;
  modalTicket: TicketDetail | null = null;
  modalLoading = false;

  constructor() {
    afterNextRender(() => {
      this.loadAppData();
    });
  }

  escapeHtml(text: string): string {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async loadAppData() {
    try {
      const [users, companies] = await Promise.all([
        this.api.getUsers(),
        this.api.getCompanies(),
      ]);
      this.users = users;
      this.companies = companies;

      const now = new Date();
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      this.startDate = firstOfMonth.toISOString().slice(0, 10);
      this.endDate = now.toISOString().slice(0, 10);
    } catch (err) {
      if ((err as Error).message === 'unauthorized') {
        this.auth.logout();
      }
    }
  }

  async search() {
    if (!this.selectedUser) {
      alert('Por favor seleccione un usuario');
      return;
    }
    if (!this.startDate || !this.endDate) {
      alert('Por favor seleccione las fechas de inicio y fin');
      return;
    }

    this.loading = true;
    this.resultsVisible = false;

    try {
      const data = await this.api.getHours(
        this.selectedUser,
        this.selectedCompany,
        this.startDate,
        this.endDate
      );
      this.data = data;
      this.resultsVisible = true;
      this.selectedCompanyFilter = null;
      this.renderResults();
    } catch (err) {
      if ((err as Error).message === 'unauthorized') {
        this.auth.logout();
      } else {
        alert('Error al consultar: ' + (err as Error).message);
      }
    } finally {
      this.loading = false;
    }
  }

  getSummaryCards() {
    if (!this.data) return [];
    return [
      { value: this.data.totalHours, label: 'Total HH Registradas', accent: true },
      { value: this.data.ticketsWithHours, label: 'Tickets con HH', accent: false },
      { value: this.data.ticketsWorked, label: 'Tickets Trabajados', accent: false },
      { value: this.data.hoursByCompany.length, label: 'Empresas', accent: false },
    ];
  }

  get filteredTickets() {
    if (!this.data) return [];
    let tickets = this.data.hoursByTicket;
    if (this.selectedCompanyFilter) {
      tickets = tickets.filter(t => t.company === this.selectedCompanyFilter);
    }
    return tickets;
  }

  get filteredDayHours(): { date: string; hours: number }[] {
    if (!this.data) return [];
    if (!this.selectedCompanyFilter) return this.data.hoursByDay;

    const dayTotals: Record<string, number> = {};
    const filteredTickets = this.data.hoursByTicket.filter(
      t => t.company === this.selectedCompanyFilter
    );
    filteredTickets.forEach(t => {
      t.comments.forEach(c => {
        const day = c.date.slice(0, 10);
        dayTotals[day] = (dayTotals[day] || 0) + c.hours;
      });
    });
    return Object.entries(dayTotals)
      .map(([date, hours]) => ({ date, hours: Math.round(hours * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  get periodLabelsAndValues(): { labels: string[]; values: number[] } {
    const dayHours = this.filteredDayHours;
    const periodType = this.periodType;

    if (periodType === 'week') {
      const grouped: Record<string, number> = {};
      dayHours.forEach(d => {
        const date = new Date(d.date);
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        const key = weekStart.toISOString().slice(0, 10);
        grouped[key] = (grouped[key] || 0) + d.hours;
      });
      const keys = Object.keys(grouped).sort();
      return {
        labels: keys.map(k => `Sem ${k}`),
        values: keys.map(k => Math.round(grouped[k] * 100) / 100),
      };
    } else if (periodType === 'month') {
      const grouped: Record<string, number> = {};
      dayHours.forEach(d => {
        const key = d.date.slice(0, 7);
        grouped[key] = (grouped[key] || 0) + d.hours;
      });
      const keys = Object.keys(grouped).sort();
      return {
        labels: keys,
        values: keys.map(k => Math.round(grouped[k] * 100) / 100),
      };
    } else {
      return {
        labels: dayHours.map(d => d.date),
        values: dayHours.map(d => d.hours),
      };
    }
  }

  get companySummary() {
    if (!this.data) return [];
    return this.data.hoursByCompany;
  }

  // ─── Render all charts ───

  renderResults() {
    if (!this.data) return;
    this.renderDonutChart();
    this.renderPeriodChart();
    this.renderPriorityChart();
  }

  renderDonutChart() {
    if (!this.data) return;
    if (this.chartCompany) this.chartCompany.destroy();

    const canvas = this.chartCompanyCanvas?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Build color map
    this.data.hoursByCompany.forEach((d, i) => {
      this.companyColorMap[d.company] = COMPANY_PALETTE[i % COMPANY_PALETTE.length];
    });

    const bgColors = this.data.hoursByCompany.map(d =>
      this.selectedCompanyFilter && d.company !== this.selectedCompanyFilter
        ? '#e8e8e8'
        : this.companyColorMap[d.company] || '#999'
    );

    const _this = this;

    this.chartCompany = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: this.data.hoursByCompany.map(d => d.company),
        datasets: [{
          data: this.data.hoursByCompany.map(d => d.hours),
          backgroundColor: bgColors,
          borderWidth: this.selectedCompanyFilter ? 2 : 0,
          borderColor: this.data.hoursByCompany.map(d =>
            d.company === this.selectedCompanyFilter ? this.companyColorMap[d.company] : 'transparent'
          ),
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '65%',
        onClick: (_event, activeElements) => {
          if (!_this.data) return;
          if (activeElements.length > 0) {
            const idx = activeElements[0].index;
            const company = _this.data.hoursByCompany[idx].company;
            _this.selectedCompanyFilter = _this.selectedCompanyFilter === company ? null : company;
          } else {
            _this.selectedCompanyFilter = null;
          }
          _this.renderDonutChart();
          _this.renderPeriodChart();
        },
        plugins: {
          legend: { position: 'right', labels: { font: { size: 12 } } },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.label}: ${ctx.raw} HH`,
            }
          }
        }
      },
      plugins: [{
        id: 'centerText',
        beforeDraw(chart) {
          const { width, height, ctx: chartCtx } = chart;
          chartCtx.save();
          const text = _this.selectedCompanyFilter || 'Todas';
          chartCtx.font = 'bold 13px sans-serif';
          chartCtx.fillStyle = _this.selectedCompanyFilter ? '#1a1a2e' : '#888';
          chartCtx.textAlign = 'center';
          chartCtx.textBaseline = 'middle';
          chartCtx.fillText(text, width / 2, height / 2);
          chartCtx.restore();
        }
      }]
    });
  }

  renderPeriodChart() {
    if (!this.data) return;
    if (this.chartPeriod) this.chartPeriod.destroy();

    const canvas = this.chartPeriodCanvas?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { labels, values } = this.periodLabelsAndValues;

    const barColor = this.selectedCompanyFilter
      ? (this.companyColorMap[this.selectedCompanyFilter] || '#4e79a7')
      : '#4e79a7';

    this.chartPeriod = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'HH',
          data: values,
          backgroundColor: barColor,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } },
          x: { ticks: { maxRotation: 45, font: { size: 10 } } }
        }
      }
    });
  }

  renderPriorityChart() {
    if (!this.data || !this.data.hoursByPriority) return;
    if (this.chartPriority) this.chartPriority.destroy();

    const canvas = this.chartPriorityCanvas?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const total = this.data.hoursByPriority.reduce((s, d) => s + d.hours, 0);

    this.chartPriority = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: this.data.hoursByPriority.map(d => d.label),
        datasets: [{
          data: this.data.hoursByPriority.map(d => d.hours),
          backgroundColor: this.data.hoursByPriority.map(d => d.color),
          borderWidth: 2,
          borderColor: '#fff',
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '55%',
        plugins: {
          legend: { position: 'right', labels: { font: { size: 12 } } },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.label}: ${ctx.raw} HH`,
            }
          }
        }
      },
      plugins: [{
        id: 'priorityCenter',
        beforeDraw(chart) {
          const { width, height, ctx: chartCtx } = chart;
          chartCtx.save();
          chartCtx.font = 'bold 18px sans-serif';
          chartCtx.fillStyle = '#1a1a2e';
          chartCtx.textAlign = 'center';
          chartCtx.textBaseline = 'middle';
          chartCtx.fillText(total + ' HH', width / 2, height / 2);
          chartCtx.restore();
        }
      }]
    });
  }

  onPeriodTypeChange() {
    this.renderPeriodChart();
  }

  // ─── Ticket modal ───

  async showTicket(ticketNumber: string) {
    this.modalLoading = true;
    this.modalActive = true;
    this.modalTicket = null;

    try {
      const ticket = await this.api.getTicket(ticketNumber);
      this.modalTicket = ticket;
    } catch (err) {
      alert('Error al cargar ticket: ' + (err as Error).message);
      this.modalActive = false;
    } finally {
      this.modalLoading = false;
    }
  }

  closeModal() {
    this.modalActive = false;
    this.modalTicket = null;
  }

  onModalOverlayClick(event: MouseEvent) {
    if ((event.target as HTMLElement).classList.contains('modal-overlay')) {
      this.closeModal();
    }
  }
}
