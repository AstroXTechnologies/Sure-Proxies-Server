import * as admin from 'firebase-admin';

export class UserModel {
  uid: string;
  email: string;
  fullName: string;
  phoneNumber: string;
  createdAt: number;
  lastLogin: number;
  purchases: any[];
  role: 'user' | 'admin';
}

export interface UserDoc {
  uid: string;
  email: string;
  fullName: string;
  phoneNumber: string;
  // Timestamps may be Firestore Timestamp objects or serialized ISO strings (when returned by APIs)
  createdAt: admin.firestore.Timestamp | string | null;
  lastLogin: admin.firestore.Timestamp | string | null;
  purchases: unknown[];
  role: UserRole;
  isActive?: boolean; // defaults to true, false = suspended
}

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
}
