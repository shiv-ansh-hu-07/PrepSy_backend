import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Module({
  providers: [PrismaService],
  exports: [PrismaService],   // <-- MISSING LINE (caused your error)
})
export class PrismaModule {}
