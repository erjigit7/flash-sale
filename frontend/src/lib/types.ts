export type Role = 'BUYER' | 'SHOP';
export type SaleStatus = 'UPCOMING' | 'LIVE' | 'ENDED';
export type ReservationStatus = 'ACTIVE' | 'CHECKOUT' | 'PURCHASED' | 'EXPIRED' | 'RELEASED' | 'CANCELLED';
export type OrderStatus = 'PENDING' | 'PAID' | 'FAILED';
export type Scenario = 'SUCCESS' | 'DECLINE' | 'HANG';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Sale {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
  priceCents: number;
  oldPriceCents: number | null;
  totalQty: number;
  available: number;
  withdrawnQty: number;
  maxPerOrder: number;
  startsAt: string;
  endsAt: string;
  version: number;
  status: SaleStatus;
}

export interface CartItem {
  id: string;
  saleId: string;
  quantity: number;
  unitPriceCents: number;
  status: ReservationStatus;
  expiresAt: string;
  createdAt: string;
  sale: { title: string; endsAt: string };
  order: { id: string; status: OrderStatus } | null;
}

export interface Order {
  id: string;
  saleId: string;
  reservationId: string;
  quantity: number;
  amountCents: number;
  status: OrderStatus;
  scenario: Scenario;
  createdAt: string;
  resolvedAt: string | null;
  sale: { title: string };
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface SaleStats {
  id: string;
  title: string;
  status: SaleStatus;
  priceCents: number;
  totalQty: number;
  startsAt: string;
  endsAt: string;
  available: number;
  inCarts: number;
  awaitingPayment: number;
  sold: number;
  withdrawn: number;
  revenueCents: number;
  ordersPaid: number;
  ordersPending: number;
  ordersFailed: number;
}
