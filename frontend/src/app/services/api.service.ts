export interface User {
  name: string;
  email: string;
  company: string;
  companies: string[];
  roles: string[];
}

export interface HoursResponse {
  totalHours: number;
  hoursByCompany: { company: string; hours: number }[];
  hoursByDay: { date: string; hours: number }[];
  hoursByTicket: TicketHours[];
  hoursByPriority: { label: string; hours: number; color: string }[];
  ticketsWorked: number;
  ticketsWithHours: number;
}

export interface TicketHours {
  ticketNumber: string;
  title: string;
  company: string;
  system: string;
  status: string;
  priority: string;
  priorityColor: string;
  totalHours: number;
  comments: { date: string; hours: number; message: string }[];
}

export interface TicketDetail {
  ticketNumber: string;
  title: string;
  company: string;
  system: string;
  status: string;
  assignedTo: string;
  reportedBy: { name: string };
  date: string;
  tag: string;
  message: string;
  comments: { date: string; hours: number; createdBy: string; message: string; hasFile: boolean; fileName: string }[];
  statusChanges: { date: string; modifiedBy: string; status: string }[];
}

import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ApiService {
  async getUsers(): Promise<User[]> {
    const res = await fetch('/api/users');
    if (res.status === 401) throw new Error('unauthorized');
    return res.json();
  }

  async getCompanies(): Promise<string[]> {
    const res = await fetch('/api/companies');
    if (res.status === 401) throw new Error('unauthorized');
    return res.json();
  }

  async getHours(user: string, company: string, start: string, end: string): Promise<HoursResponse> {
    const params = new URLSearchParams({ user, company, start, end });
    const res = await fetch(`/api/hours?${params}`);
    if (res.status === 401) throw new Error('unauthorized');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  async getTicket(ticketNumber: string): Promise<TicketDetail> {
    const res = await fetch(`/api/ticket/${ticketNumber}`);
    return res.json();
  }
}
