import { DatabaseSync } from "node:sqlite";

class TestD1Statement {
  constructor(owner, sql, bindings = []) {
    this.owner = owner;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new TestD1Statement(this.owner, this.sql, bindings);
  }

  execute() {
    const statement = this.owner.sqlite.prepare(this.sql);
    return /^\s*(?:SELECT|WITH|PRAGMA)/i.test(this.sql)
      ? { results: statement.all(...this.bindings) }
      : statement.run(...this.bindings);
  }

  async run() {
    const result = this.execute();
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }

  async first() {
    return this.owner.sqlite.prepare(this.sql).get(...this.bindings) ?? null;
  }

  async all() {
    return { results: this.owner.sqlite.prepare(this.sql).all(...this.bindings) };
  }
}

export class TestD1Database {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.failNextBatchAt = null;
  }

  exec(sql) {
    this.sqlite.exec(sql);
  }

  prepare(sql) {
    return new TestD1Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (this.failNextBatchAt === index) throw new Error("simulated-d1-atomic-failure");
        results.push(statements[index].execute());
      }
      this.sqlite.exec("COMMIT");
      this.failNextBatchAt = null;
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      this.failNextBatchAt = null;
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}
