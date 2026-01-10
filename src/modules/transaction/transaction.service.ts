/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { BadRequestException, Injectable } from '@nestjs/common';
import { db } from 'src/main';
import { CreateTransactionDto, UpdateTransactionDto } from './transaction.dto';
import { Transaction, TransactionHistory } from './transaction.model';

@Injectable()
export class TransactionsService {
  private collection = 'transactions';
  private historyCollection = 'transaction_histories';

  async create(
    userId: string,
    dto: CreateTransactionDto,
  ): Promise<Transaction> {
    const id = db.collection(this.collection).doc().id;
    const transaction: Transaction = {
      id,
      userId,
      type: dto.type,
      amount: dto.amount,
      status: 'PENDING',
      reference: dto.reference,
      createdAt: new Date(),
    };

    await db.collection(this.collection).doc(id).set(transaction);

    await this.createHistory(
      transaction.id,
      userId,
      `Transaction created: ${dto.type} of amount ${dto.amount}`,
    );

    return transaction;
  }

  private async createHistory(
    transactionId: string,
    userId: string,
    description: string,
  ): Promise<void> {
    const id = db.collection(this.historyCollection).doc().id;
    const history: TransactionHistory = {
      id,
      transactionId,
      userId,
      description,
      createdAt: new Date(),
    };
    await db.collection(this.historyCollection).doc(id).set(history);
  }

  async findAll(userId: string): Promise<Transaction[]> {
    const snapshot = await db
      .collection(this.collection)
      .where('userId', '==', userId)
      .get();
    return snapshot.docs.map((doc) => doc.data() as Transaction);
  }

  async getTransactionById(transactionId: string): Promise<Transaction> {
    const ref = db.collection(this.collection).doc(transactionId);
    const doc = await ref.get();

    if (!doc.exists) {
      throw new BadRequestException('Transaction not found');
    }

    return doc.data() as Transaction;
  }

  // async update(id: string, dto: UpdateTransactionDto): Promise<Transaction> {
  //   const ref = db.collection(this.collection).doc(id);
  //   const existing = await ref.get();

  //   if (!existing.exists)
  //     throw new BadRequestException('Transaction not found');

  //   const transaction = existing.data() as Transaction;

  //   await ref.update({ status: dto.status });
  //   const updated = { ...transaction, status: dto.status };

  //   await this.createHistory(
  //     id,
  //     transaction.userId,
  //     `Transaction status updated to ${dto.status}`,
  //   );

  //   if (dto.status === 'SUCCESS') {
  //     await this.createHistory(
  //       id,
  //       transaction.userId,
  //       `Transaction status updated to ${dto.status}`,
  //     );
  //   }

  //   return updated;
  // }

  async update(
    id: string,
    dto: UpdateTransactionDto,
    historyMessage?: string,
  ): Promise<Transaction> {
    const ref = db.collection(this.collection).doc(id);
    const existing = await ref.get();

    if (!existing.exists)
      throw new BadRequestException('Transaction not found');

    const transaction = existing.data() as Transaction;

    if (transaction.status === dto.status) {
      return transaction; // no change
    }

    await ref.update({ status: dto.status });
    const updated = { ...transaction, status: dto.status };

    // Use caller-provided history message when available to avoid duplicate/overlapping history entries
    const message =
      historyMessage || `Transaction status updated to ${dto.status}`;
    await this.createHistory(id, transaction.userId, message);

    return updated;
  }

  async getTransactionHistoryByTransactionId(
    transactionId: string,
  ): Promise<TransactionHistory[]> {
    const snapshot = await db
      .collection(this.historyCollection)
      .where('transactionId', '==', transactionId)
      .orderBy('createdAt', 'desc')
      .get();

    return snapshot.docs.map((doc) => doc.data() as TransactionHistory);
  }

  async getTransactionHistoryByUserId(
    userId: string,
  ): Promise<TransactionHistory[]> {
    const snapshot = await db
      .collection(this.historyCollection)
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();

    return snapshot.docs.map((doc) => doc.data() as TransactionHistory);
  }

  // ========== ADMIN METHODS ==========

  async findAllAdmin(
    page: number,
    limit: number,
    filters?: {
      status?: string;
      type?: string;
      userId?: string;
    },
  ): Promise<{
    total: number;
    page: number;
    limit: number;
    data: Transaction[];
  }> {
    let query: FirebaseFirestore.Query = db
      .collection(this.collection)
      .orderBy('createdAt', 'desc');

    // Apply filters
    if (filters?.status) {
      query = query.where('status', '==', filters.status);
    }
    if (filters?.type) {
      query = query.where('type', '==', filters.type);
    }
    if (filters?.userId) {
      query = query.where('userId', '==', filters.userId);
    }

    // Get all matching docs for total count
    const allDocs = await query.get();
    const total = allDocs.size;

    // Paginate
    const offset = (page - 1) * limit;
    const pageDocs = allDocs.docs.slice(offset, offset + limit);

    const data = pageDocs.map((doc) => {
      const docData = doc.data();
      return {
        ...docData,
        id: doc.id,
        createdAt:
          typeof docData.createdAt?.toDate === 'function'
            ? docData.createdAt.toDate()
            : docData.createdAt,
      } as Transaction;
    });

    return { total, page, limit, data };
  }

  async getTransactionStats(): Promise<{
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    total: number;
  }> {
    const snapshot = await db.collection(this.collection).get();
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};

    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      const status = data.status as string;
      const type = data.type as string;

      byStatus[status] = (byStatus[status] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;
    });

    return {
      byStatus,
      byType,
      total: snapshot.size,
    };
  }
}
