import { PrismaClient } from '../../prisma/generated/prisma/client/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config/env';

const adapter = new PrismaPg({ connectionString: config.DATABASE_URL, max: 20, min: 5 });

export const prisma = new PrismaClient({ adapter });
