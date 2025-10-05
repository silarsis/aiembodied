import { vi } from 'vitest';

vi.mock('prom-client', () => {
  class MockHistogram {
    public name: string;
    private count = 0;

    constructor(configuration: { name: string; registers?: Array<{ registerMetric: (histogram: MockHistogram) => void }> }) {
      this.name = configuration.name;
      for (const registry of configuration.registers ?? []) {
        registry.registerMetric(this);
      }
    }

    observe(valueOrLabels: number | Record<string, string>, maybeValue?: number): void {
      const value = typeof valueOrLabels === 'number' ? valueOrLabels : maybeValue;
      if (typeof value === 'number' && Number.isFinite(value)) {
        this.count += 1;
      }
    }

    metrics(): string {
      return `${this.name}_count ${this.count}`;
    }
  }

  class MockRegistry {
    contentType = 'text/plain';
    private readonly metricsList: MockHistogram[] = [];

    registerMetric(metric: MockHistogram): void {
      this.metricsList.push(metric);
    }

    async metrics(): Promise<string> {
      return this.metricsList.map((metric) => metric.metrics()).join('\n');
    }
  }

  const collectDefaultMetrics = vi.fn();

  return {
    Histogram: MockHistogram,
    Registry: MockRegistry,
    collectDefaultMetrics,
  };
});
