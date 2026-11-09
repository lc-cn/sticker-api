// 极简 JSON Schema 2020-12 子集校验器（零依赖）。
// 支持：$ref(本地 #/... 与按 $id 的跨文件引用) $defs type enum const required properties
// additionalProperties patternProperties? propertyNames minProperties maxProperties items prefixItems
// minItems maxItems uniqueItems minLength maxLength(按码点) pattern(u) minimum maximum
// format:date-time allOf anyOf oneOf not if/then/else。未知关键字会抛错，避免“静默不校验”。

const KNOWN = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description', '$comment', 'type', 'enum', 'const', 'required',
  'properties', 'additionalProperties', 'propertyNames', 'minProperties', 'maxProperties', 'items', 'prefixItems',
  'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'format',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'default', 'examples',
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export class SchemaRegistry {
  constructor() { this.byId = new Map(); this.patternCache = new Map(); }

  add(schema) {
    if (!schema.$id) throw new Error('schema 缺少 $id');
    this.byId.set(schema.$id, schema);
    return this;
  }

  resolveRef(ref, baseId) {
    const [idPart, frag = ''] = ref.split('#');
    const id = idPart === '' ? baseId : idPart;
    const root = this.byId.get(id);
    if (!root) throw new Error(`无法解析 $ref: ${ref}`);
    let node = root;
    if (frag) {
      for (const seg of frag.replace(/^\//, '').split('/')) {
        node = node?.[decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'))];
        if (node === undefined) throw new Error(`无法解析 $ref 片段: ${ref}`);
      }
    }
    return { schema: node, baseId: id };
  }

  re(p) {
    let r = this.patternCache.get(p);
    if (!r) { r = new RegExp(p, 'u'); this.patternCache.set(p, r); }
    return r;
  }

  /** 返回错误数组 [{path, message}]，空数组表示通过 */
  validate(id, value) {
    const errors = [];
    const root = this.byId.get(id);
    if (!root) throw new Error(`未知 schema: ${id}`);
    this._v(root, value, '$', id, errors);
    return errors;
  }

  _v(s, v, path, baseId, errors) {
    if (s === true) return;
    if (s === false) { errors.push({ path, message: '不允许出现' }); return; }
    if (s.$id) baseId = s.$id;
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`schema 使用了不支持的关键字 ${k}（${path}）`);
    const push = (message) => errors.push({ path, message });

    if (s.$ref) {
      const r = this.resolveRef(s.$ref, baseId);
      this._v(r.schema, v, path, r.baseId, errors);
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeMatches(v, t))) { push(`类型应为 ${types.join('|')}，实际 ${typeOf(v)}`); return; }
    }
    if (s.enum && !s.enum.some((e) => deepEqual(e, v))) push(`取值不在枚举内: ${JSON.stringify(v)}`);
    if ('const' in s && !deepEqual(s.const, v)) push(`应为常量 ${JSON.stringify(s.const)}`);

    const t = typeOf(v);
    if (t === 'string') {
      const len = [...v].length;
      if (s.minLength !== undefined && len < s.minLength) push(`长度应≥${s.minLength}`);
      if (s.maxLength !== undefined && len > s.maxLength) push(`长度应≤${s.maxLength}`);
      if (s.pattern && !this.re(s.pattern).test(v)) push(`不匹配 pattern ${s.pattern}`);
      if (s.format === 'date-time' && (!DATE_TIME.test(v) || Number.isNaN(Date.parse(v)))) push('不是合法 date-time');
    }
    if (t === 'integer' || t === 'number') {
      if (s.minimum !== undefined && v < s.minimum) push(`应≥${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) push(`应≤${s.maximum}`);
    }
    if (t === 'array') {
      if (s.minItems !== undefined && v.length < s.minItems) push(`元素数应≥${s.minItems}`);
      if (s.maxItems !== undefined && v.length > s.maxItems) push(`元素数应≤${s.maxItems}`);
      if (s.uniqueItems) {
        for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) if (deepEqual(v[i], v[j])) { push(`元素重复: ${JSON.stringify(v[i])}`); i = v.length; break; }
      }
      const prefix = s.prefixItems || [];
      prefix.forEach((ps, i) => { if (i < v.length) this._v(ps, v[i], `${path}[${i}]`, baseId, errors); });
      if (s.items !== undefined) for (let i = prefix.length; i < v.length; i++) this._v(s.items, v[i], `${path}[${i}]`, baseId, errors);
    }
    if (t === 'object') {
      const keys = Object.keys(v);
      if (s.minProperties !== undefined && keys.length < s.minProperties) push(`属性数应≥${s.minProperties}`);
      if (s.maxProperties !== undefined && keys.length > s.maxProperties) push(`属性数应≤${s.maxProperties}`);
      for (const r of s.required || []) if (!Object.prototype.hasOwnProperty.call(v, r)) push(`缺少必填字段 ${r}`);
      const props = s.properties || {};
      for (const k of keys) {
        const p = `${path}.${k}`;
        if (s.propertyNames) this._v(s.propertyNames, k, `${p}(键名)`, baseId, errors);
        if (Object.prototype.hasOwnProperty.call(props, k)) this._v(props[k], v[k], p, baseId, errors);
        else if (s.additionalProperties === false) errors.push({ path: p, message: '不允许的额外字段' });
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') this._v(s.additionalProperties, v[k], p, baseId, errors);
      }
    }
    if (s.allOf) for (const sub of s.allOf) this._v(sub, v, path, baseId, errors);
    if (s.anyOf) {
      if (!s.anyOf.some((sub) => this._sub(sub, v, path, baseId).length === 0)) push('不满足 anyOf 任一分支');
    }
    if (s.oneOf) {
      const results = s.oneOf.map((sub) => this._sub(sub, v, path, baseId));
      const ok = results.filter((r) => r.length === 0).length;
      if (ok !== 1) {
        push(`应恰好满足 oneOf 一个分支（满足 ${ok} 个）`);
        if (ok === 0) { const best = results.reduce((a, b) => (b.length < a.length ? b : a)); errors.push(...best); }
      }
    }
    if (s.not && this._sub(s.not, v, path, baseId).length === 0) push('不应满足 not');
    if (s.if) {
      const pass = this._sub(s.if, v, path, baseId).length === 0;
      if (pass && s.then) this._v(s.then, v, path, baseId, errors);
      if (!pass && s.else) this._v(s.else, v, path, baseId, errors);
    }
  }

  _sub(s, v, path, baseId) { const e = []; this._v(s, v, path, baseId, e); return e; }
}
