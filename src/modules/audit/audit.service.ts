/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Injectable } from '@nestjs/common';
import { db } from 'src/main';
import { AuditLog, CreateAuditLogDto } from './audit.model';

@Injectable()
export class AuditService {
  private collection = 'admin_audit_logs';

  async create(dto: CreateAuditLogDto): Promise<AuditLog> {
    const id = db.collection(this.collection).doc().id;
    const log: AuditLog = {
      id,
      ...dto,
      createdAt: new Date(),
    };

    await db.collection(this.collection).doc(id).set(log);
    console.log(
      `📝 [AUDIT] ${dto.adminEmail} performed ${dto.action} on ${dto.targetType}:${dto.targetId}`,
    );
    return log;
  }

  async findAll(
    page = 1,
    limit = 50,
    filters?: {
      action?: string;
      adminId?: string;
      targetType?: string;
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<{ total: number; page: number; limit: number; data: AuditLog[] }> {
    let query: FirebaseFirestore.Query = db
      .collection(this.collection)
      .orderBy('createdAt', 'desc');

    // Apply filters
    if (filters?.action) {
      query = query.where('action', '==', filters.action);
    }
    if (filters?.adminId) {
      query = query.where('adminId', '==', filters.adminId);
    }
    if (filters?.targetType) {
      query = query.where('targetType', '==', filters.targetType);
    }

    // Get total count (expensive for Firestore but needed for pagination)
    const allDocs = await query.get();

    // Date filtering (client-side due to Firestore limitations with multiple range queries)
    let filteredDocs = allDocs.docs;
    if (filters?.startDate) {
      filteredDocs = filteredDocs.filter((doc) => {
        const data = doc.data();
        const createdAt =
          data.createdAt?.toDate?.() || new Date(data.createdAt);
        return createdAt >= filters.startDate!;
      });
    }
    if (filters?.endDate) {
      filteredDocs = filteredDocs.filter((doc) => {
        const data = doc.data();
        const createdAt =
          data.createdAt?.toDate?.() || new Date(data.createdAt);
        return createdAt <= filters.endDate!;
      });
    }

    // Paginate
    const offset = (page - 1) * limit;
    const pageDocs = filteredDocs.slice(offset, offset + limit);

    const data = pageDocs.map((doc) => {
      const docData = doc.data();
      return {
        ...docData,
        id: doc.id,
        createdAt: docData.createdAt?.toDate?.() || new Date(docData.createdAt),
      } as AuditLog;
    });

    return { total: filteredDocs.length, page, limit, data };
  }

  async findByTarget(
    targetType: string,
    targetId: string,
  ): Promise<AuditLog[]> {
    const snapshot = await db
      .collection(this.collection)
      .where('targetType', '==', targetType)
      .where('targetId', '==', targetId)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        ...data,
        id: doc.id,
        createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
      } as AuditLog;
    });
  }

  async getActionStats(): Promise<Record<string, number>> {
    const snapshot = await db.collection(this.collection).get();
    const stats: Record<string, number> = {};

    snapshot.docs.forEach((doc) => {
      const action = doc.data().action;
      stats[action] = (stats[action] || 0) + 1;
    });

    return stats;
  }
}
