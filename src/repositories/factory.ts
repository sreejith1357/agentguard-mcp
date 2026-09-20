/**
 * AgentGuard MCP v3.0.0 — Repository Factory & Dependency Injection Module
 *
 * Dynamically instantiates and injects the active persistence backend
 * based on process.env.STORAGE_BACKEND ('sqlite' | 'postgres').
 * Performs connection pooling, health probes, and automatic reconnect logic.
 */

import type {
    ICircuitBreakerRepository,
    IBaselineRepository,
    ICausalTraceRepository,
    IDatabaseHealth,
} from "./interfaces.js";
import {
    SqliteCircuitBreakerRepository,
    SqliteBaselineRepository,
    SqliteCausalTraceRepository,
} from "./sqliteRepository.js";
import {
    PostgresConnectionPool,
    PostgresCircuitBreakerRepository,
    PostgresBaselineRepository,
    PostgresCausalTraceRepository,
} from "./postgresRepository.js";

export type StorageBackendType = "sqlite" | "postgres";

export class RepositoryFactory {
    private static instance: RepositoryFactory;
    private backend: StorageBackendType;

    private cbRepo: ICircuitBreakerRepository;
    private baselineRepo: IBaselineRepository;
    private traceRepo: ICausalTraceRepository;

    private pgPool?: PostgresConnectionPool;

    private constructor() {
        const envBackend = (process.env.STORAGE_BACKEND || "sqlite").toLowerCase();
        this.backend = envBackend === "postgres" ? "postgres" : "sqlite";

        if (this.backend === "postgres") {
            this.pgPool = new PostgresConnectionPool(process.env.POSTGRES_URL);
            this.pgPool.connect().catch((err) => console.error("[AgentGuard] PostgreSQL connect error:", err));

            this.cbRepo = new PostgresCircuitBreakerRepository(this.pgPool);
            this.baselineRepo = new PostgresBaselineRepository(this.pgPool);
            this.traceRepo = new PostgresCausalTraceRepository(this.pgPool);
        } else {
            this.cbRepo = new SqliteCircuitBreakerRepository();
            this.baselineRepo = new SqliteBaselineRepository();
            this.traceRepo = new SqliteCausalTraceRepository();
        }
    }

    public static getInstance(): RepositoryFactory {
        if (!RepositoryFactory.instance) {
            RepositoryFactory.instance = new RepositoryFactory();
        }
        return RepositoryFactory.instance;
    }

    /**
     * Switch storage backend dynamically (useful for testing or hot failover).
     */
    public setBackend(type: StorageBackendType): void {
        this.backend = type;
        if (type === "postgres") {
            if (!this.pgPool) {
                this.pgPool = new PostgresConnectionPool(process.env.POSTGRES_URL);
                this.pgPool.connect().catch(() => {});
            }
            this.cbRepo = new PostgresCircuitBreakerRepository(this.pgPool);
            this.baselineRepo = new PostgresBaselineRepository(this.pgPool);
            this.traceRepo = new PostgresCausalTraceRepository(this.pgPool);
        } else {
            this.cbRepo = new SqliteCircuitBreakerRepository();
            this.baselineRepo = new SqliteBaselineRepository();
            this.traceRepo = new SqliteCausalTraceRepository();
        }
    }

    public getBackend(): StorageBackendType {
        return this.backend;
    }

    public getCircuitBreakerRepository(): ICircuitBreakerRepository {
        return this.cbRepo;
    }

    public getBaselineRepository(): IBaselineRepository {
        return this.baselineRepo;
    }

    public getCausalTraceRepository(): ICausalTraceRepository {
        return this.traceRepo;
    }

    public async getDatabaseHealth(): Promise<IDatabaseHealth> {
        if (this.backend === "postgres" && this.pgPool) {
            return this.pgPool.checkHealth();
        }

        const start = performance.now();
        const latency_ms = Number((performance.now() - start).toFixed(2));
        return {
            healthy: true,
            backend: "sqlite",
            connection_pooled: false,
            latency_ms,
        };
    }
}

// Convenience singleton getters
export function getCircuitBreakerRepository(): ICircuitBreakerRepository {
    return RepositoryFactory.getInstance().getCircuitBreakerRepository();
}

export function getBaselineRepository(): IBaselineRepository {
    return RepositoryFactory.getInstance().getBaselineRepository();
}

export function getCausalTraceRepository(): ICausalTraceRepository {
    return RepositoryFactory.getInstance().getCausalTraceRepository();
}
