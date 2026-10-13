"use strict";

const COLUMNS = "id, title, priority, status, created_at AS \"createdAt\", updated_at AS \"updatedAt\"";

function createTaskRepository(pool) {
  return {
    async create({ title, priority = 3 }) {
      const { rows } = await pool.query(
        `INSERT INTO tasks (title, priority) VALUES ($1, $2) RETURNING ${COLUMNS}`,
        [title, priority],
      );
      return rows[0];
    },

    async get(id) {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM tasks WHERE id = $1`, [id]);
      return rows[0];
    },

    async list({ page, pageSize, status }) {
      const where = status ? "WHERE status = $1" : "";
      const params = status ? [status] : [];
      const offset = page * pageSize;

      const [{ rows }, count] = await Promise.all([
        pool.query(
          `SELECT ${COLUMNS} FROM tasks ${where} ORDER BY id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        ),
        pool.query(`SELECT count(*)::int AS total FROM tasks ${where}`, params),
      ]);
      return { items: rows, page, pageSize, total: count.rows[0].total };
    },

    async update(id, changes) {
      const fields = [];
      const values = [];
      for (const key of ["title", "priority", "status"]) {
        if (changes[key] !== undefined) {
          values.push(changes[key]);
          fields.push(`${key} = $${values.length}`);
        }
      }
      values.push(id);
      const { rows } = await pool.query(
        `UPDATE tasks SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING ${COLUMNS}`,
        values,
      );
      return rows[0];
    },

    async remove(id) {
      const { rowCount } = await pool.query("DELETE FROM tasks WHERE id = $1", [id]);
      return rowCount > 0;
    },
  };
}

module.exports = { createTaskRepository };
