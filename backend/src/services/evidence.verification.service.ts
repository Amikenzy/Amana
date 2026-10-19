import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { metrics } from "@opentelemetry/api";
import { runtimeEnvValue } from "../config/env";
import { prisma as defaultPrisma } from "../lib/db";
import { IPFSService, PinVerificationResult } from "./ipfs.service";
import { appLogger } from "../middleware/logger";

const MAX_CID_VERIFICATION_ATTEMPTS = 3;
const meter = metrics.getMeter("amana-backend");
const verificationBatchDuration = meter.createHistogram(
  "evidence_verification_batch_duration_ms",
  {
    description: "Duration of an evidence verification batch",
    unit: "ms",
  },
);
const verificationBatchCount = meter.createCounter(
  "evidence_verification_batches_total",
  { description: "Number of evidence verification batches processed" },
);
const verificationRetryCount = meter.createCounter(
  "evidence_verification_retries_total",
  { description: "Number of evidence CID verification retries" },
);

export interface EvidenceVerificationRecord {
  evidenceId: number;
  tradeId: string;
  cid: string;
  filename: string;
  mimeType: string;
  uploadedBy: string;
  createdAt: Date;
  pinResult: PinVerificationResult;
}

export interface VerificationReport {
  totalChecked: number;
  pinnedCount: number;
  missingCount: number;
  errorCount: number;
  missingPins: EvidenceVerificationRecord[];
  errors: EvidenceVerificationRecord[];
  checkedAt: Date;
  durationMs: number;
}

export interface VerificationProgress {
  processed: number;
  total: number;
  batchNumber: number;
  batchDurationMs: number;
}

export interface RepairResult {
  evidenceId: number;
  cid: string;
  success: boolean;
  error?: string;
}

type EvidenceDatabase = {
  tradeEvidence: Pick<
    PrismaClient["tradeEvidence"],
    "findMany" | "count" | "update"
  >;
};

export class EvidenceVerificationService {
  private ipfs: Pick<IPFSService, "verifyPin" | "uploadFile" | "getFileUrl">;
  private batchSize: number;

  constructor(
    private readonly prisma: EvidenceDatabase = defaultPrisma as unknown as EvidenceDatabase,
    ipfs?: Pick<IPFSService, "verifyPin" | "uploadFile" | "getFileUrl">,
    batchSize: number = runtimeEnvValue("EVIDENCE_PIN_VERIFICATION_BATCH_SIZE"),
  ) {
    this.ipfs = ipfs ?? new IPFSService();
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError("Evidence verification batch size must be a positive integer");
    }
    this.batchSize = batchSize;
  }

  /**
   * Run a full verification pass over all evidence records.
   * Checks each CID against Pinata and returns a structured report.
   */
  async verifyAll(
    onProgress?: (progress: VerificationProgress) => void | Promise<void>,
  ): Promise<VerificationReport> {
    const startTime = Date.now();
    appLogger.info("[EvidenceVerification] Starting full verification pass");

    const missingPins: EvidenceVerificationRecord[] = [];
    const errors: EvidenceVerificationRecord[] = [];
    let pinnedCount = 0;
    let processed = 0;
    let batchNumber = 0;
    let lastRecord: { id: number; createdAt: Date } | undefined;
    const totalRecords = await this.prisma.tradeEvidence.count();
    let hasMore = true;

    appLogger.info(
      { totalRecords, batchSize: this.batchSize },
      "[EvidenceVerification] Checking evidence records against Pinata",
    );

    while (hasMore) {
      const batchStart = performance.now();
      let batch: Awaited<
        ReturnType<EvidenceDatabase["tradeEvidence"]["findMany"]>
      > = [];
      let outcome = "success";

      try {
        batch = await this.prisma.tradeEvidence.findMany({
          ...(lastRecord
            ? {
                where: {
                  OR: [
                    { createdAt: { gt: lastRecord.createdAt } },
                    {
                      createdAt: lastRecord.createdAt,
                      id: { gt: lastRecord.id },
                    },
                  ],
                },
              }
            : {}),
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: this.batchSize,
        });

        if (batch.length === 0) {
          hasMore = false;
          continue;
        }

        const cidResults = new Map<string, PinVerificationResult>();
        const uniqueCids = [...new Set(batch.map((record) => record.cid))];
        const batchResults = await this.verifyCidBatch(uniqueCids);
        for (const [cid, result] of batchResults) {
          cidResults.set(cid, result);
        }

        for (const record of batch) {
          const pinResult = cidResults.get(record.cid) ?? {
            pinned: false,
            cid: record.cid,
            error: "No verification result",
          };

          const enriched: EvidenceVerificationRecord = {
            evidenceId: record.id,
            tradeId: record.tradeId,
            cid: record.cid,
            filename: record.filename,
            mimeType: record.mimeType,
            uploadedBy: record.uploadedBy,
            createdAt: record.createdAt,
            pinResult,
          };

          if (pinResult.error && !pinResult.pinned) {
            errors.push(enriched);
          } else if (pinResult.pinned) {
            pinnedCount++;
          } else {
            missingPins.push(enriched);
          }
        }

        processed += batch.length;
        batchNumber++;
        const batchDurationMs = performance.now() - batchStart;
        appLogger.info(
          {
            batchNumber,
            processed,
            totalRecords,
            batchSize: batch.length,
            batchDurationMs,
          },
          "[EvidenceVerification] Batch complete",
        );
        await onProgress?.({
          processed,
          total: totalRecords,
          batchNumber,
          batchDurationMs,
        });
        verificationBatchCount.add(1, { outcome: "success" });
        lastRecord = batch[batch.length - 1];
      } catch (error) {
        outcome = "error";
        verificationBatchCount.add(1, { outcome });
        throw error;
      } finally {
        if (batch.length > 0 || outcome === "error") {
          verificationBatchDuration.record(performance.now() - batchStart, {
            outcome,
          });
        }
      }
    }

    if (batchNumber === 0) {
      await onProgress?.({
        processed: 0,
        total: totalRecords,
        batchNumber: 0,
        batchDurationMs: 0,
      });
    }

    const durationMs = Date.now() - startTime;

    const report: VerificationReport = {
      totalChecked: processed,
      pinnedCount,
      missingCount: missingPins.length,
      errorCount: errors.length,
      missingPins,
      errors,
      checkedAt: new Date(),
      durationMs,
    };

    appLogger.info(
      {
        totalChecked: report.totalChecked,
        pinned: report.pinnedCount,
        missing: report.missingCount,
        errors: report.errorCount,
        durationMs,
      },
      "[EvidenceVerification] Verification pass complete",
    );

    if (missingPins.length > 0) {
      appLogger.warn(
        { missingCids: missingPins.map((r) => r.cid) },
        "[EvidenceVerification] Missing pins detected",
      );
    }

    return report;
  }

  private async verifyCidBatch(
    cids: string[],
  ): Promise<Map<string, PinVerificationResult>> {
    const results = new Map<string, PinVerificationResult>();
    let pendingCids = cids;

    for (
      let attempt = 1;
      pendingCids.length > 0 && attempt <= MAX_CID_VERIFICATION_ATTEMPTS;
      attempt++
    ) {
      const outcomes = await Promise.all(
        pendingCids.map(async (cid) => {
          try {
            return {
              cid,
              result: await this.ipfs.verifyPin(cid),
              failed: false as const,
            };
          } catch (error) {
            return { cid, error, failed: true as const };
          }
        }),
      );
      const failedCids: string[] = [];

      outcomes.forEach((outcome) => {
        const { cid } = outcome;
        if (!outcome.failed && !outcome.result.error) {
          results.set(cid, outcome.result);
        } else if (attempt < MAX_CID_VERIFICATION_ATTEMPTS) {
          failedCids.push(cid);
        } else {
          results.set(
            cid,
            !outcome.failed
              ? outcome.result
              : {
                  pinned: false,
                  cid,
                  error:
                  outcome.error instanceof Error
                    ? outcome.error.message
                    : "Unknown verification error",
                },
          );
        }
      });

      if (failedCids.length > 0) {
        verificationRetryCount.add(failedCids.length);
        appLogger.warn(
          {
            attempt,
            retryCount: failedCids.length,
            maxAttempts: MAX_CID_VERIFICATION_ATTEMPTS,
          },
          "[EvidenceVerification] Retrying failed CID verifications",
        );
        await new Promise((resolve) =>
          setTimeout(resolve, 100 * 2 ** (attempt - 1)),
        );
        pendingCids = failedCids;
      } else {
        pendingCids = [];
      }
    }

    return results;
  }

  /**
   * Attempt to re-pin missing evidence by fetching the file from the IPFS
   * gateway and re-uploading it to Pinata. This is a best-effort repair
   * that only works if the content is still available via gateway.
   */
  async repairMissingPins(
    missingRecords: EvidenceVerificationRecord[],
  ): Promise<RepairResult[]> {
    const results: RepairResult[] = [];

    for (const record of missingRecords) {
      try {
        appLogger.info(
          { evidenceId: record.evidenceId, cid: record.cid },
          "[EvidenceVerification] Attempting repair",
        );

        const fileBuffer = await this.fetchFromGateway(record.cid);
        if (!fileBuffer) {
          results.push({
            evidenceId: record.evidenceId,
            cid: record.cid,
            success: false,
            error: "File not available on gateway",
          });
          continue;
        }

        const newCid = await this.ipfs.uploadFile(fileBuffer, record.filename);

        if (newCid !== record.cid) {
          appLogger.warn(
            {
              evidenceId: record.evidenceId,
              originalCid: record.cid,
              newCid,
            },
            "[EvidenceVerification] Re-pinned CID mismatch — updating record",
          );
        }

        await this.prisma.tradeEvidence.update({
          where: { id: record.evidenceId },
          data: { cid: newCid },
        });

        results.push({
          evidenceId: record.evidenceId,
          cid: record.cid,
          success: true,
        });

        appLogger.info(
          { evidenceId: record.evidenceId, cid: newCid },
          "[EvidenceVerification] Repair successful",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        appLogger.error(
          { err, evidenceId: record.evidenceId, cid: record.cid },
          "[EvidenceVerification] Repair failed",
        );
        results.push({
          evidenceId: record.evidenceId,
          cid: record.cid,
          success: false,
          error: message,
        });
      }
    }

    return results;
  }

  /**
   * Fetch a file from the IPFS gateway by CID. Returns the buffer
   * or null if the file is not available.
   */
  private async fetchFromGateway(cid: string): Promise<Buffer | null> {
    try {
      const url = this.ipfs.getFileUrl(cid);
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 30_000,
        validateStatus: (s) => s < 400,
      });
      return Buffer.from(response.data);
    } catch {
      return null;
    }
  }
}
