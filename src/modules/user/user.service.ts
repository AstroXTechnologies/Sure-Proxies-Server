import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { db, dbAuth } from 'src/main';
import { VirtualAccountService } from 'src/modules/account/virtual/account.service';
import { PaymentpointService } from 'src/modules/paymentpoint/paymentpoint.service';
import { UserDoc, UserRole } from 'src/modules/user/user.model';
import { CreateUserDTO } from './user.dto';

@Injectable()
export class UserService {
  constructor(
    private readonly paymentpointService: PaymentpointService,
    private readonly virtualAccountService: VirtualAccountService,
  ) {}

  // Safely format various timestamp/values returned from Firestore into ISO strings
  private formatValue(val: unknown): string | null {
    if (val == null) return null;

    // Some Firestore SDKs return objects with a toDate() method (duck-typing)
    if (typeof val === 'object' && val !== null) {
      // Detect Firestore-like timestamp objects that expose `seconds` or `_seconds`
      const asObj = val as Record<string, unknown>;
      const seconds =
        typeof asObj.seconds === 'number'
          ? asObj.seconds
          : typeof asObj._seconds === 'number'
            ? asObj._seconds
            : undefined;
      if (typeof seconds === 'number') {
        try {
          return new Date(seconds * 1000).toISOString();
        } catch {
          // ignore
        }
      }
    }

    if (typeof val === 'string') return val;
    if (typeof val === 'number') return new Date(val).toISOString();

    try {
      const s = JSON.stringify(val);
      return s === undefined ? null : s;
    } catch {
      return null;
    }
  }

  public async create(model: CreateUserDTO): Promise<UserDoc> {
    let authUserId: string | null = null;
    let userDocCreated = false;

    try {
      // Step 1: Create Firebase Auth user
      console.log('📝 [USER CREATION] Creating Firebase Auth user:', {
        email: model.email,
        fullName: model.fullName,
      });

      const record = await dbAuth.createUser({
        displayName: model.fullName,
        email: model.email,
        password: model.password,
      });

      if (!record) {
        throw new HttpException(
          'Unable to create account. Please try again.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      authUserId = record.uid;
      console.log('✅ [USER CREATION] Firebase Auth user created:', authUserId);

      // Step 2: Save user document to Firestore
      console.log('📝 [USER CREATION] Saving user document to Firestore');
      await this.saveUser(record.uid, {
        uid: record.uid,
        email: model.email,
        fullName: model.fullName,
        phoneNumber: model.phoneNumber,
        createdAt: admin.firestore.Timestamp.now(),
        lastLogin: admin.firestore.Timestamp.now(),
        purchases: [],
        role: UserRole.USER,
      } as UserDoc);

      userDocCreated = true;
      console.log('✅ [USER CREATION] User document saved');

      // Step 3: Create virtual account (non-blocking, with retry safety)
      console.log('📝 [USER CREATION] Creating virtual account');
      try {
        await this.virtualAccountService.ensureVirtualAccount(record.uid);
        console.log(
          '✅ [USER CREATION] Virtual account created and saved:',
          record.uid,
        );
      } catch (virtualAccountError: any) {
        // Log error but don't fail user creation
        // Virtual account will be created lazily on first purchase/deposit
        console.warn(
          '⚠️ [USER CREATION] Failed to create virtual account during registration:',
          {
            userId: record.uid,
            error:
              virtualAccountError instanceof Error
                ? virtualAccountError.message
                : String(virtualAccountError || 'Unknown error'),
            willCreateLazily: true,
          },
        );
      }

      // Step 4: Verify user creation
      const userDoc = await db.collection('users').doc(record.uid).get();
      const data = userDoc.data() as UserDoc | undefined;

      if (!data) {
        throw new HttpException(
          'Account created but verification failed. Please contact support.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      console.log('✅ [USER CREATION] User creation completed:', record.uid);

      return {
        uid: data.uid,
        email: data.email,
        fullName: data.fullName,
        phoneNumber: data.phoneNumber,
        createdAt: data.createdAt,
        lastLogin: data.lastLogin,
        purchases: data.purchases,
        role: data.role,
      };
    } catch (error: any) {
      console.error('❌ [USER CREATION] Error during user creation:', {
        error: error instanceof Error ? error.message : String(error),
        email: model.email,
      });

      // Rollback: Clean up any partially created resources
      if (authUserId) {
        console.log('🔄 [USER CREATION] Rolling back - deleting auth user');
        try {
          await dbAuth.deleteUser(authUserId);
          console.log('✅ [USER CREATION] Auth user deleted');
        } catch (deleteError) {
          console.error(
            '❌ [USER CREATION] Failed to delete auth user during rollback:',
            deleteError,
          );
        }
      }

      if (userDocCreated && authUserId) {
        console.log('🔄 [USER CREATION] Rolling back - deleting user document');
        try {
          await db.collection('users').doc(authUserId).delete();
          console.log('✅ [USER CREATION] User document deleted');
        } catch (deleteError) {
          console.error(
            '❌ [USER CREATION] Failed to delete user document during rollback:',
            deleteError,
          );
        }
      }

      throw error;
    }
  }

  async saveUser(userId: string, userData: UserDoc): Promise<void> {
    try {
      const userRef = db.collection('users').doc(userId);
      await userRef.set(userData);
    } catch (error) {
      console.error('❌ [USER] Error saving user in db:', error);
      throw new HttpException(
        'Unable to save account information. Please try again.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  public async findAll(): Promise<UserDoc[]> {
    const usersSnapshot = await db.collection('users').get();
    return usersSnapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown> | undefined;

      return {
        id: doc.id,
        uid: data && typeof data.uid === 'string' ? data.uid : doc.id,
        email: data && typeof data.email === 'string' ? data.email : '',
        fullName:
          data && typeof data.fullName === 'string' ? data.fullName : '',
        phoneNumber:
          data && typeof data.phoneNumber === 'string' ? data.phoneNumber : '',
        createdAt: this.formatValue(data ? data['createdAt'] : undefined),
        lastLogin: this.formatValue(data ? data['lastLogin'] : undefined),
        purchases:
          data && Array.isArray(data['purchases'])
            ? (data['purchases'] as unknown[])
            : [],
        role: (data && (data['role'] as UserRole)) ?? UserRole.USER,
      } as UserDoc;
    });
  }

  /**
   * Simple offset-based pagination. Returns { total, page, limit, data }
   */
  public async findPaginated(
    page: number,
    limit: number,
    q?: string,
  ): Promise<{ total: number; page: number; limit: number; data: UserDoc[] }> {
    const col = db.collection('users');

    // Build base query
    const query: FirebaseFirestore.Query = col.orderBy('createdAt', 'desc');

    // Basic text search on email or fullName if 'q' provided
    if (q && q.trim()) {
      const trimmed = q.trim().toLowerCase();
      // Firestore doesn't support OR easily; fallback: fetch more and filter client-side
      const snapshot = await query.get();
      const allDocs = snapshot.docs.map((d) => ({ id: d.id, data: d.data() }));
      const filtered = allDocs.filter((it) => {
        const data = it.data as Record<string, unknown> | undefined;
        const email = (
          data && typeof data.email === 'string' ? data.email : ''
        ).toLowerCase();
        const name = (
          data && typeof data.fullName === 'string' ? data.fullName : ''
        ).toLowerCase();
        return email.includes(trimmed) || name.includes(trimmed);
      });
      const total = filtered.length;
      const start = (page - 1) * limit;
      const pageDocs = filtered.slice(start, start + limit);
      const data = pageDocs.map((d) => {
        const data = d.data as Record<string, unknown> | undefined;
        return {
          id: d.id,
          uid: data && typeof data.uid === 'string' ? data.uid : d.id,
          email: data && typeof data.email === 'string' ? data.email : '',
          fullName:
            data && typeof data.fullName === 'string' ? data.fullName : '',
          phoneNumber:
            data && typeof data.phoneNumber === 'string'
              ? data.phoneNumber
              : '',
          createdAt: this.formatValue(data ? data['createdAt'] : undefined),
          lastLogin: this.formatValue(data ? data['lastLogin'] : undefined),
          purchases:
            data && Array.isArray(data['purchases'])
              ? (data['purchases'] as unknown[])
              : [],
          role: (data && (data['role'] as UserRole)) ?? UserRole.USER,
        } as UserDoc;
      });

      return { total, page, limit, data };
    }

    // Non-search path: use offset/limit
    const offset = (page - 1) * limit;
    const totalSnapshot = await col.get();
    const total = totalSnapshot.size;

    const snapshot = await query.offset(offset).limit(limit).get();

    const data = snapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown> | undefined;
      return {
        id: doc.id,
        uid: data && typeof data.uid === 'string' ? data.uid : doc.id,
        email: data && typeof data.email === 'string' ? data.email : '',
        fullName:
          data && typeof data.fullName === 'string' ? data.fullName : '',
        phoneNumber:
          data && typeof data.phoneNumber === 'string' ? data.phoneNumber : '',
        createdAt: this.formatValue(data ? data['createdAt'] : undefined),
        lastLogin: this.formatValue(data ? data['lastLogin'] : undefined),
        purchases:
          data && Array.isArray(data['purchases'])
            ? (data['purchases'] as unknown[])
            : [],
        role: (data && (data['role'] as UserRole)) ?? UserRole.USER,
      } as UserDoc;
    });

    return { total, page, limit, data };
  }

  async findOne(id: string) {
    const user = await db.collection('users').doc(id).get();
    if (!user.exists) {
      throw new HttpException('Account not found', HttpStatus.NOT_FOUND);
    }
    const data = user.data() as Record<string, unknown> | undefined;

    return {
      id: user.id,
      uid: data && typeof data.uid === 'string' ? data.uid : user.id,
      email: data && typeof data.email === 'string' ? data.email : '',
      fullName: data && typeof data.fullName === 'string' ? data.fullName : '',
      phoneNumber:
        data && typeof data.phoneNumber === 'string' ? data.phoneNumber : '',
      createdAt: this.formatValue(data ? data['createdAt'] : undefined),
      lastLogin: this.formatValue(data ? data['lastLogin'] : undefined),
      purchases:
        data && Array.isArray(data['purchases'])
          ? (data['purchases'] as unknown[])
          : [],
      role: (data && (data['role'] as UserRole)) ?? UserRole.USER,
    };
  }

  async update(id: string, model: UserDoc) {
    const user = await this.findOne(id);
    const updatedUser = { ...user, ...model };
    await this.saveUser(id, updatedUser);
    return updatedUser;
  }

  async remove(id: string) {
    const user = await this.findOne(id);
    await db.collection('users').doc(id).delete();
    return user;
  }
}
