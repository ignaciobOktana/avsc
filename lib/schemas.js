/* jshint node: true */

// TODO: Add logging using `debuglog` to help identify schema parsing errors.
// TODO: Add schema inference capabilities (as writable stream?).
// TODO: Look into slow buffers for field defaults.
// TODO: Use toFastProperties on type reverse indices.
// TODO: Allow configuring when to write the size when writing arrays and maps,
// and customizing their block size.
// TODO: Change `wrapUnions` to let type declarations be self-representing.
// E.g. renaming it to `coerceUnions`, with possible values 0 `DISABLED`, 1
// `WRAP_FIRST`, 2 `WRAP_ALL`, 3 `UNWRAP`.
// TODO: Code-generate `compare` and `clone` record and union methods.

'use strict';


var utils = require('./utils'),
    buffer = require('buffer'), // For `SlowBuffer`.
    crypto = require('crypto'),
    util = require('util');

// Convenience imports.
var Tap = utils.Tap;
var f = util.format;

// All Avro types.
var TYPES = {
  'array': ArrayType,
  'boolean': BooleanType,
  'bytes': BytesType,
  'double': DoubleType,
  'enum': EnumType,
  'error': RecordType,
  'fixed': FixedType,
  'float': FloatType,
  'int': IntType,
  'long': LongType,
  'map': MapType,
  'null': NullType,
  'record': RecordType,
  'string': StringType,
  'union': UnionType
};

// Valid (field, type, and symbol) name regex.
var NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Random generator.
var RANDOM = new utils.Lcg();

// Encoding tap (shared for performance).
var TAP = new Tap(new buffer.SlowBuffer(1024));

// Path prefix for validity checks (shared for performance).
var PATH = [];


/**
 * "Abstract" base Avro type class.
 *
 * The constructor will register any named types to support recursive schemas.
 *
 */
function Type(registry) {
  var name = this._name;
  if (registry === undefined || name === undefined) {
    return;
  }
  var prev = registry[name];
  if (prev !== undefined && prev !== this) {
    throw new Error(f('duplicate type name: %s', name));
  }
  registry[name] = this;
}

Type.__reset = function (size) { TAP.buf = new buffer.SlowBuffer(size); };

Type.prototype.decode = function (buf, pos, resolver) {
  var tap = new Tap(buf);
  tap.pos = pos | 0;
  var val = readValue(this, tap, resolver);
  if (!tap.isValid()) {
    return {value: undefined, offset: -1};
  }
  return {value: val, offset: tap.pos};
};

Type.prototype.encode = function (val, buf, pos) {
  var tap = new Tap(buf);
  tap.pos = pos | 0;
  this._write(tap, val);
  if (!tap.isValid()) {
    // Don't throw as there is no way to predict this. We also return the
    // number of missing bytes to ease resizing.
    return buf.length - tap.pos;
  }
  return tap.pos;
};

Type.prototype.fromBuffer = function (buf, resolver, noCheck) {
  var tap = new Tap(buf);
  var val = readValue(this, tap, resolver, noCheck);
  if (!tap.isValid()) {
    throw new Error('truncated buffer');
  }
  if (!noCheck && tap.pos < buf.length) {
    throw new Error('trailing data');
  }
  return val;
};

Type.prototype.toBuffer = function (val) {
  TAP.pos = 0;
  this._write(TAP, val);
  if (!TAP.isValid()) {
    Type.__reset(2 * TAP.pos);
    TAP.pos = 0;
    this._write(TAP, val);
  }
  var buf = new Buffer(TAP.pos);
  TAP.buf.copy(buf, 0, 0, TAP.pos);
  return buf;
};

Type.prototype.fromString = function (str) {
  return this.clone(JSON.parse(str), {coerceBuffers: true});
};

Type.prototype.toString = function (val) {
  if (val === undefined) {
    return this.getSchema(true);
  }
  return JSON.stringify(val, function (key, value) {
    if (value && value.type === 'Buffer' && value.data instanceof Array) {
      return new Buffer(value.data).toString('binary');
    } else {
      return value;
    }
  });
};

Type.prototype.isValid = function (val, opts) {
  while (PATH.length) {
    // In case the previous `isValid` call didn't complete successfully (e.g.
    // if an exception was thrown, but then caught in client code), `PATH`
    // might be non-empty, we must manually clear it.
    PATH.pop();
  }
  return this._check(val, opts && opts.errorHook);
};

Type.prototype.createResolver = function (type, opts) {
  if (!(type instanceof Type)) {
    // More explicit error message than the "incompatible type" thrown
    // otherwise (especially because of the overridden `toString` method).
    throw new Error(f('not a type: %j', type));
  }

  opts = opts || {};
  opts.registry = opts.registry || {};

  var resolver, key;
  if (this instanceof RecordType && type instanceof RecordType) {
    key = this._name + ':' + type._name; // ':' is illegal in Avro type names.
    resolver = opts.registry[key];
    if (resolver) {
      return resolver;
    }
  }

  resolver = new Resolver(this);
  if (key) { // Register resolver early for recursive schemas.
    opts.registry[key] = resolver;
  }

  if (type instanceof UnionType) {
    var resolvers = type._types.map(function (t) {
      return this.createResolver(t, opts);
    }, this);
    resolver._read = function (tap) {
      var index = tap.readLong();
      var resolver = resolvers[index];
      if (resolver === undefined) {
        throw new Error(f('invalid union index: %s', index));
      }
      return resolvers[index]._read(tap);
    };
  } else {
    this._updateResolver(resolver, type, opts);
  }

  if (!resolver._read) {
    throw new Error(f('incompatible types: %s %s', this, type));
  }
  return resolver;
};

Type.prototype.compareBuffers = function (buf1, buf2) {
  return this._match(new Tap(buf1), new Tap(buf2));
};

Type.prototype.getSchema = function (noDeref) {
  // Return the canonical version of the schema.
  // Since JS objects are unordered, this implementation (unfortunately)
  // relies on engines returning properties in the same order that they are
  // inserted in. This is not in the JS spec, but can be "somewhat" safely
  // assumed (more here: http://stackoverflow.com/q/5525795/1062617).
  return (function (type, registry) {
    return JSON.stringify(type, function (key, value) {
      if (value && !value.hasOwnProperty('default') && value.name) {
        // We use the `default` own property check to filter out fields.
        var name = value.name;
        if (noDeref || registry[name]) {
          return name;
        }
        registry[name] = true;
      }
      return value;
    });
  })(this, {});
};

Type.prototype.getFingerprint = function (algorithm) {
  algorithm = algorithm || 'md5';
  var hash = crypto.createHash(algorithm);
  hash.end(this.toString());
  return hash.read();
};

Type.prototype.inspect = function () { return this.toJSON(); };

Type.prototype._check = utils.abstractFunction;
Type.prototype._read = utils.abstractFunction;
Type.prototype._skip = utils.abstractFunction;
Type.prototype._write = utils.abstractFunction;
Type.prototype._match = utils.abstractFunction;
Type.prototype._updateResolver = utils.abstractFunction;
Type.prototype.clone = utils.abstractFunction;
Type.prototype.compare = utils.abstractFunction;
Type.prototype.random = utils.abstractFunction;

// Implementations.

/**
 * Base primitive Avro type.
 *
 * Most of the primitive types share the same cloning and resolution
 * mechanisms, provided by this class. This class also lets us conveniently
 * check whether a type is a primitive using `instanceof`.
 *
 */
function PrimitiveType() { Type.call(this); }
util.inherits(PrimitiveType, Type);
PrimitiveType.prototype._updateResolver = function (resolver, type) {
  if (type.constructor === this.constructor) {
    resolver._read = this._read;
  }
};
PrimitiveType.prototype.clone = function (val) {
  this._check(val, throwInvalidError);
  return val;
};
PrimitiveType.prototype.compare = utils.compare;

/**
 * Null values.
 *
 */
function NullType() { PrimitiveType.call(this); }
util.inherits(NullType, PrimitiveType);
NullType.prototype._check = function (val, cb) {
  var b = val === null;
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};
NullType.prototype._read = function () { return null; };
NullType.prototype._skip = function () {};
NullType.prototype._write = function (tap, val) {
  if (val !== null) {
    throwInvalidError(null, val, this);
  }
};
NullType.prototype._match = function () { return 0; };
NullType.prototype.compare = NullType.prototype._match;
NullType.prototype.random = NullType.prototype._read;
NullType.prototype.toJSON = function () { return 'null'; };

/**
 * Booleans.
 *
 */
function BooleanType() { PrimitiveType.call(this); }
util.inherits(BooleanType, PrimitiveType);
BooleanType.prototype._check = function (val, cb) {
  var b = typeof val == 'boolean';
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};
BooleanType.prototype._read = function (tap) { return tap.readBoolean(); };
BooleanType.prototype._skip = function (tap) { tap.skipBoolean(); };
BooleanType.prototype._write = function (tap, val) {
  if (typeof val != 'boolean') {
    throwInvalidError(null, val, this);
  }
  tap.writeBoolean(val);
};
BooleanType.prototype._match = function (tap1, tap2) {
  return tap1.matchBoolean(tap2);
};
BooleanType.prototype.random = function () { return RANDOM.nextBoolean(); };
BooleanType.prototype.toJSON = function () { return 'boolean'; };

/**
 * Integers.
 *
 */
function IntType() { PrimitiveType.call(this); }
util.inherits(IntType, PrimitiveType);
IntType.prototype._check = function (val, cb) {
  var b = val === (val | 0);
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};
IntType.prototype._read = function (tap) { return tap.readInt(); };
IntType.prototype._skip = function (tap) { tap.skipInt(); };
IntType.prototype._write = function (tap, val) {
  if (val !== (val | 0)) {
    throwInvalidError(null, val, this);
  }
  tap.writeInt(val);
};
IntType.prototype._match = function (tap1, tap2) {
  return tap1.matchInt(tap2);
};
IntType.prototype.random = function () { return RANDOM.nextInt(1000) | 0; };
IntType.prototype.toJSON = function () { return 'int'; };

/**
 * Longs.
 *
 * We can't capture all the range unfortunately, so the default implementation
 * plays safe and throws rather than potentially silently change the data.
 *
 */
function LongType() { PrimitiveType.call(this); }
util.inherits(LongType, PrimitiveType);
LongType.prototype._check = function (val, cb) {
  var b = typeof val == 'number' && val % 1 === 0 && isSafeLong(val);
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};
LongType.prototype._read = function (tap) {
  var n = tap.readLong();
  if (!isSafeLong(n)) {
    throw new Error('potential precision loss');
  }
  return n;
};
LongType.prototype._skip = function (tap) { tap.skipLong(); };
LongType.prototype._write = function (tap, val) {
  if (typeof val != 'number' || val % 1 || !isSafeLong(val)) {
    throwInvalidError(null, val, this);
  }
  tap.writeLong(val);
};
LongType.prototype._match = function (tap1, tap2) {
  return tap1.matchLong(tap2);
};
LongType.prototype._updateResolver = function (resolver, type) {
  if (type instanceof LongType || type instanceof IntType) {
    resolver._read = type._read;
  }
};
LongType.prototype.random = function () { return RANDOM.nextInt(); };
LongType.prototype.toJSON = function () { return 'long'; };
LongType.using = function (methods, noUnpack) {
  methods = methods || {}; // Will give a more helpful error message.
  // We map some of the methods to a different name to be able to intercept
  // their input and output (otherwise we wouldn't be able to perform any
  // unpacking logic, and the type wouldn't work when nested).
  var mapping = {
    toBuffer: '_toBuffer',
    fromBuffer: '_fromBuffer',
    fromJSON: '_fromJSON',
    isValid: '_isValid',
    compare: 'compare'
  };
  var type = new AbstractLongType(noUnpack);
  Object.keys(mapping).forEach(function (name) {
    if (methods[name] === undefined) {
      throw new Error(f('missing method implementation: %s', name));
    }
    type[mapping[name]] = methods[name];
  });
  return type;
};

/**
 * Customizable long.
 *
 * This allows support of arbitrarily large long (e.g. larger than
 * `Number.MAX_SAFE_INTEGER`). It can be used for example via the parsing
 * registry.
 *
 */
function AbstractLongType(noUnpack) {
  LongType.call(this);
  this._noUnpack = !!noUnpack;
}
util.inherits(AbstractLongType, LongType);

AbstractLongType.prototype._check = function (val, cb) {
  var b = this._isValid(val);
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};

AbstractLongType.prototype._read = function (tap) {
  var buf, pos;
  if (this._noUnpack) {
    pos = tap.pos;
    tap.skipLong();
    buf = tap.buf.slice(pos, tap.pos);
  } else {
    buf = tap.unpackLongBytes(tap);
  }
  if (tap.isValid()) {
    return this._fromBuffer(buf);
  }
};

AbstractLongType.prototype._write = function (tap, val) {
  if (!this._isValid(val)) {
    throwInvalidError(null, val, this);
  }
  var buf = this._toBuffer(val);
  if (this._noUnpack) {
    tap.writeFixed(buf);
  } else {
    tap.packLongBytes(buf);
  }
};

AbstractLongType.prototype.clone = function (val) {
  // Slow but guarantees most consistent results. Faster alternatives would
  // require assumptions on the long class used (e.g. immutability).
  return this._fromJSON(JSON.parse(JSON.stringify(val)));
};

AbstractLongType.prototype.random = function () {
  return this.clone(LongType.prototype.random());
};

// Methods to be implemented by the user.
AbstractLongType.prototype._isValid = utils.abstractFunction;
AbstractLongType.prototype._toBuffer = utils.abstractFunction;
AbstractLongType.prototype._fromBuffer = utils.abstractFunction;
AbstractLongType.prototype._fromJSON = utils.abstractFunction;
AbstractLongType.prototype.compare = utils.abstractFunction;

/**
 * Floats.
 *
 */
function FloatType() { PrimitiveType.call(this); }
util.inherits(FloatType, PrimitiveType);
FloatType.prototype._check = function (val, cb) {
  var b = typeof val == 'number';
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};
FloatType.prototype._read = function (tap) { return tap.readFloat(); };
FloatType.prototype._skip = function (tap) { tap.skipFloat(); };
FloatType.prototype._write = function (tap, val) {
  if (typeof val != 'number') {
    throwInvalidError(null, val, this);
  }
  tap.writeFloat(val);
};
FloatType.prototype._match = function (tap1, tap2) {
  return tap1.matchFloat(tap2);
};
FloatType.prototype._updateResolver = function (resolver, type) {
  if (
    type instanceof FloatType ||
    type instanceof LongType ||
    type instanceof IntType
  ) {
    resolver._read = type._read;
  }
};
FloatType.prototype.random = function () { return RANDOM.nextFloat(1e3); };
FloatType.prototype.toJSON = function () { return 'float'; };

/**
 * Doubles.
 *
 */
function DoubleType() { PrimitiveType.call(this); }
util.inherits(DoubleType, PrimitiveType);
DoubleType.prototype._check = function (val, cb) {
  var b = typeof val == 'number';
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};
DoubleType.prototype._read = function (tap) { return tap.readDouble(); };
DoubleType.prototype._skip = function (tap) { tap.skipDouble(); };
DoubleType.prototype._write = function (tap, val) {
  if (typeof val != 'number') {
    throwInvalidError(null, val, this);
  }
  tap.writeDouble(val);
};
DoubleType.prototype._match = function (tap1, tap2) {
  return tap1.matchDouble(tap2);
};
DoubleType.prototype._updateResolver = function (resolver, type) {
  if (
    type instanceof DoubleType ||
    type instanceof FloatType ||
    type instanceof LongType ||
    type instanceof IntType
  ) {
    resolver._read = type._read;
  }
};
DoubleType.prototype.random = function () { return RANDOM.nextFloat(); };
DoubleType.prototype.toJSON = function () { return 'double'; };

/**
 * Strings.
 *
 */
function StringType() { PrimitiveType.call(this); }
util.inherits(StringType, PrimitiveType);
StringType.prototype._check = function (val, cb) {
  var b = typeof val == 'string';
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};
StringType.prototype._read = function (tap) { return tap.readString(); };
StringType.prototype._skip = function (tap) { tap.skipString(); };
StringType.prototype._write = function (tap, val) {
  if (typeof val != 'string') {
    throwInvalidError(null, val, this);
  }
  tap.writeString(val);
};
StringType.prototype._match = function (tap1, tap2) {
  return tap1.matchString(tap2);
};
StringType.prototype._updateResolver = function (resolver, type) {
  if (type instanceof StringType || type instanceof BytesType) {
    resolver._read = this._read;
  }
};
StringType.prototype.random = function () {
  return RANDOM.nextString(RANDOM.nextInt(32));
};
StringType.prototype.toJSON = function () { return 'string'; };

/**
 * Bytes.
 *
 * Note the coercing handling in `clone`.
 *
 */
function BytesType() { PrimitiveType.call(this); }
util.inherits(BytesType, PrimitiveType);
BytesType.prototype._check = function (val, cb) {
  var b = Buffer.isBuffer(val);
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};
BytesType.prototype._read = function (tap) { return tap.readBytes(); };
BytesType.prototype._skip = function (tap) { tap.skipBytes(); };
BytesType.prototype._write = function (tap, val) {
  if (!Buffer.isBuffer(val)) {
    throwInvalidError(null, val, this);
  }
  tap.writeBytes(val);
};
BytesType.prototype._match = function (tap1, tap2) {
  return tap1.matchBytes(tap2);
};
BytesType.prototype._updateResolver = StringType.prototype._updateResolver;
BytesType.prototype.clone = function (val, opts) {
  val = tryCloneBuffer(val, opts && opts.coerceBuffers);
  this._check(val, throwInvalidError);
  return val;
};
BytesType.prototype.compare = Buffer.compare;
BytesType.prototype.random = function () {
  return RANDOM.nextBuffer(RANDOM.nextInt(32));
};
BytesType.prototype.toJSON = function () { return 'bytes'; };

/**
 * Avro unions.
 *
 */
function UnionType(schema, opts) {
  if (!(schema instanceof Array)) {
    throw new Error(f('non-array union schema: %j', schema));
  }
  if (!schema.length) {
    throw new Error('empty union');
  }

  opts = getOpts(schema, opts);
  Type.call(this);
  this._types = schema.map(function (obj) {
    return createType(obj, opts);
  });

  this._indices = {};
  this._types.forEach(function (type, i) {
    if (type instanceof UnionType) {
      throw new Error('unions cannot be directly nested');
    }
    var name = type._name || getTypeName(type);
    if (this._indices[name] !== undefined) {
      throw new Error(f('duplicate union name: %j', name));
    }
    this._indices[name] = i;
  }, this);

  this._constructors = this._types.map(function (type) {
    // jshint -W054
    var name = type._name || getTypeName(type);
    if (name === 'null') {
      return null;
    }
    var body;
    if (~name.indexOf('.')) { // Qualified name.
      body = 'this[\'' + name + '\'] = val;';
    } else {
      body = 'this.' + name + ' = val;';
    }
    return new Function('val', body);
  });
}
util.inherits(UnionType, Type);

UnionType.prototype._check = function (val, cb) {
  var b = false;
  if (val === null) {
    // Shortcut type lookup in this case.
    b = this._indices['null'] !== undefined;
  } else if (typeof val == 'object') {
    var keys = Object.keys(val);
    if (keys.length === 1) {
      // We require a single key here to ensure that writes are correct and
      // efficient as soon as a record passes this check.
      var name = keys[0];
      var index = this._indices[name];
      if (index !== undefined) {
        PATH.push(name);
        b = this._types[index]._check(val[name], cb);
        PATH.pop();
        return b;
      }
    }
  }
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};

UnionType.prototype._read = function (tap) {
  var index = tap.readLong();
  var Class = this._constructors[index];
  if (Class) {
    return new Class(this._types[index]._read(tap));
  } else if (Class === null) {
    return null;
  } else {
    throw new Error(f('invalid union index: %s', index));
  }
};

UnionType.prototype._skip = function (tap) {
  this._types[tap.readLong()]._skip(tap);
};

UnionType.prototype._write = function (tap, val) {
  var index, keys, name;
  if (val === null) {
    index = this._indices['null'];
    if (index === undefined) {
      throwInvalidError(null, val, this);
    }
    tap.writeLong(index);
  } else {
    keys = Object.keys(val);
    if (keys.length === 1) {
      name = keys[0];
      index = this._indices[name];
    }
    if (index === undefined) {
      throwInvalidError(null, val, this);
    }
    tap.writeLong(index);
    this._types[index]._write(tap, val[name]);
  }
};

UnionType.prototype._match = function (tap1, tap2) {
  var n1 = tap1.readLong();
  var n2 = tap2.readLong();
  if (n1 === n2) {
    return this._types[n1]._match(tap1, tap2);
  } else {
    return n1 < n2 ? -1 : 1;
  }
};

UnionType.prototype._updateResolver = function (resolver, type, opts) {
  // jshint -W083
  // (The loop exits after the first function is created.)
  var i, l, typeResolver, Class;
  for (i = 0, l = this._types.length; i < l; i++) {
    try {
      typeResolver = this._types[i].createResolver(type, opts);
    } catch (err) {
      continue;
    }
    Class = this._constructors[i];
    if (Class) {
      resolver._read = function (tap) {
        return new Class(typeResolver._read(tap));
      };
    } else {
      resolver._read = function () { return null; };
    }
    return;
  }
};

UnionType.prototype.clone = function (val, opts) {
  if (opts && opts.wrapUnions) {
    // Promote values to unions (useful when parsing defaults, see `Field`
    // below for more information).
    if (val === null && this._constructors[0] === null) {
      return null;
    }
    return new this._constructors[0](this._types[0].clone(val, opts));
  } else {
    if (val === null && this._indices['null'] !== undefined) {
      return null;
    }
    if (typeof val == 'object') {
      var keys = Object.keys(val);
      if (keys.length === 1) {
        var name = keys[0];
        var i = this._indices[name];
        if (i === undefined) {
          // We are a bit more flexible than in `_check` here since we have
          // to deal with other serializers being less strict, so we fall
          // back to looking up unqualified names.
          var j, l, type;
          for (j = 0, l = this._types.length; j < l; j++) {
            type = this._types[j];
            if (type._name && name === unqualify(type._name)) {
              i = j;
              break;
            }
          }
        }
        if (i !== undefined) {
          var copy = this._types[i].clone(val[name], opts);
          return new this._constructors[i](copy);
        }
      }
    }
    throwInvalidError(null, val, this);
  }
};

UnionType.prototype.compare = function (val1, val2) {
  var name1 = val1 === null ? 'null' : Object.keys(val1)[0];
  var name2 = val2 === null ? 'null' : Object.keys(val2)[0];
  var index = this._indices[name1];
  if (name1 === name2) {
    return name1 === 'null' ?
      0 :
      this._types[index].compare(val1[name1], val2[name1]);
  } else {
    return utils.compare(index, this._indices[name2]);
  }
};

UnionType.prototype.getTypes = function () { return this._types.slice(); };

UnionType.prototype.random = function () {
  var index = RANDOM.nextInt(this._types.length);
  var Class = this._constructors[index];
  if (!Class) {
    return null;
  }
  return new Class(this._types[index].random());
};

UnionType.prototype.toJSON = function () { return this._types; };

/**
 * Avro enum type.
 *
 */
function EnumType(schema, opts) {
  if (!(schema.symbols instanceof Array) || !schema.symbols.length) {
    throw new Error(f('invalid %j enum symbols: %j', schema.name, schema));
  }

  opts = getOpts(schema, opts);
  var resolutions = resolveNames(schema, opts.namespace);
  this._name = resolutions.name;
  this._symbols = schema.symbols;
  this._aliases = resolutions.aliases;
  Type.call(this, opts.registry);

  this._indices = {};
  this._symbols.forEach(function (symbol, i) {
    if (!NAME_PATTERN.test(symbol)) {
      throw new Error(f('invalid symbol name: %s', symbol));
    }
    this._indices[symbol] = i;
  }, this);
}
util.inherits(EnumType, Type);

EnumType.prototype._check = function (val, cb) {
  var b = this._indices[val] !== undefined;
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};

EnumType.prototype._read = function (tap) {
  var index = tap.readLong();
  var symbol = this._symbols[index];
  if (symbol === undefined) {
    throw new Error(f('invalid %s enum index: %s', this._name, index));
  }
  return symbol;
};

EnumType.prototype._skip = function (tap) { tap.skipLong(); };

EnumType.prototype._write = function (tap, val) {
  if (this._indices[val] === undefined) {
    throwInvalidError(null, val, this);
  }
  tap.writeLong(this._indices[val]);
};

EnumType.prototype._match = function (tap1, tap2) {
  return tap1.matchLong(tap2);
};

EnumType.prototype.compare = function (val1, val2) {
  return utils.compare(this._indices[val1], this._indices[val2]);
};

EnumType.prototype._updateResolver = function (resolver, type) {
  var symbols = this._symbols;
  if (
    type instanceof EnumType &&
    ~getAliases(this).indexOf(type._name) &&
    type._symbols.every(function (s) { return ~symbols.indexOf(s); })
  ) {
    resolver._symbols = type._symbols;
    resolver._read = type._read;
  }
};

EnumType.prototype.clone = function (val) {
  this._check(val, throwInvalidError);
  return val;
};

EnumType.prototype.getAliases = function () { return this._aliases; };

EnumType.prototype.getFullName = function () { return this._name; };

EnumType.prototype.getSymbols = function () { return this._symbols.slice(); };

EnumType.prototype.random = function () {
  return RANDOM.choice(this._symbols);
};

EnumType.prototype.toJSON = function () {
  return {name: this._name, type: 'enum', symbols: this._symbols};
};

/**
 * Avro fixed type.
 *
 */
function FixedType(schema, opts) {
  if (schema.size !== (schema.size | 0) || schema.size < 1) {
    throw new Error(f('invalid %j fixed size: %j', schema.name, schema.size));
  }

  opts = getOpts(schema, opts);
  var resolutions = resolveNames(schema, opts.namespace);
  this._name = resolutions.name;
  this._size = schema.size | 0;
  this._aliases = resolutions.aliases;
  Type.call(this, opts.registry);
}
util.inherits(FixedType, Type);

FixedType.prototype._check = function (val, cb) {
  var b = Buffer.isBuffer(val) && val.length === this._size;
  if (!b && cb) {
    cb(PATH.slice(), val, this);
  }
  return b;
};

FixedType.prototype._read = function (tap) {
  return tap.readFixed(this._size);
};

FixedType.prototype._skip = function (tap) {
  tap.skipFixed(this._size);
};

FixedType.prototype._write = function (tap, val) {
  if (!Buffer.isBuffer(val) || val.length !== this._size) {
    throwInvalidError(null, val, this);
  }
  tap.writeFixed(val, this._size);
};

FixedType.prototype._match = function (tap1, tap2) {
  return tap1.matchFixed(tap2, this._size);
};

FixedType.prototype.compare = Buffer.compare;

FixedType.prototype._updateResolver = function (resolver, type) {
  if (
    type instanceof FixedType &&
    this._size === type._size &&
    ~getAliases(this).indexOf(type._name)
  ) {
    resolver._size = this._size;
    resolver._read = this._read;
  }
};

FixedType.prototype.clone = function (val, opts) {
  val = tryCloneBuffer(val, opts && opts.coerceBuffers);
  this._check(val, throwInvalidError);
  return val;
};

FixedType.prototype.getAliases = function () { return this._aliases; };

FixedType.prototype.getFullName = function () { return this._name; };

FixedType.prototype.getSize = function () { return this._size; };

FixedType.prototype.random = function () {
  return RANDOM.nextBuffer(this._size);
};

FixedType.prototype.toJSON = function () {
  return {name: this._name, type: 'fixed', size: this._size};
};

/**
 * Avro map.
 *
 */
function MapType(schema, opts) {
  if (!schema.values) {
    throw new Error(f('missing map values: %j', schema));
  }

  opts = getOpts(schema, opts);
  Type.call(this);
  this._values = createType(schema.values, opts);
}
util.inherits(MapType, Type);

MapType.prototype.getValuesType = function () { return this._values; };

MapType.prototype._check = function (val, cb) {
  if (!val || typeof val != 'object' || val instanceof Array) {
    if (cb) {
    cb(PATH.slice(), val, this);
    }
    return false;
  }

  var keys = Object.keys(val);
  var b = true;
  var i, l, j, key;
  if (cb) {
    // Slow path.
    j = PATH.length;
    PATH.push('');
    for (i = 0, l = keys.length; i < l; i++) {
      key = PATH[j] = keys[i];
      if (!this._values._check(val[key], cb)) {
        b = false;
      }
    }
    PATH.pop();
  } else {
    for (i = 0, l = keys.length; i < l; i++) {
      if (!this._values._check(val[keys[i]], cb)) {
        return false;
      }
    }
  }
  return b;
};

MapType.prototype._read = function (tap) {
  var values = this._values;
  var val = {};
  var n;
  while ((n = readArraySize(tap))) {
    while (n--) {
      var key = tap.readString();
      val[key] = values._read(tap);
    }
  }
  return val;
};

MapType.prototype._skip = function (tap) {
  var values = this._values;
  var len, n;
  while ((n = tap.readLong())) {
    if (n < 0) {
      len = tap.readLong();
      tap.pos += len;
    } else {
      while (n--) {
        tap.skipString();
        values._skip(tap);
      }
    }
  }
};

MapType.prototype._write = function (tap, val) {
  if (!val || typeof val != 'object' || val instanceof Array) {
    throwInvalidError(null, val, this);
  }

  var values = this._values;
  var keys = Object.keys(val);
  var n = keys.length;
  var i, key;
  if (n) {
    tap.writeLong(n);
    for (i = 0; i < n; i++) {
      key = keys[i];
      tap.writeString(key);
      values._write(tap, val[key]);
    }
  }
  tap.writeLong(0);
};

MapType.prototype._match = function () {
  throw new Error('maps cannot be compared');
};

MapType.prototype._updateResolver = function (resolver, type, opts) {
  if (type instanceof MapType) {
    resolver._values = this._values.createResolver(type._values, opts);
    resolver._read = this._read;
  }
};

MapType.prototype.clone = function (val, opts) {
  if (val && typeof val == 'object' && !(val instanceof Array)) {
    var values = this._values;
    var keys = Object.keys(val);
    var i, l, key;
    var copy = {};
    for (i = 0, l = keys.length; i < l; i++) {
      key = keys[i];
      copy[key] = values.clone(val[key], opts);
    }
    return copy;
  }
  throwInvalidError(null, val, this);
};

MapType.prototype.compare = MapType.prototype._match;

MapType.prototype.random = function () {
  var val = {};
  var i, l;
  for (i = 0, l = RANDOM.nextInt(10); i < l; i++) {
    val[RANDOM.nextString(RANDOM.nextInt(20))] = this._values.random();
  }
  return val;
};

MapType.prototype.toJSON = function () {
  return {type: 'map', values: this._values};
};

/**
 * Avro array.
 *
 */
function ArrayType(schema, opts) {
  if (!schema.items) {
    throw new Error(f('missing array items: %j', schema));
  }

  opts = getOpts(schema, opts);

  this._items = createType(schema.items, opts);
  Type.call(this);
}
util.inherits(ArrayType, Type);

ArrayType.prototype._check = function (val, cb) {
  if (!(val instanceof Array)) {
    if (cb) {
    cb(PATH.slice(), val, this);
    }
    return false;
  }

  var b = true;
  var i, l, j;
  if (cb) {
    // Slow path.
    j = PATH.length;
    PATH.push('');
    for (i = 0, l = val.length; i < l; i++) {
      PATH[j] = '' + i;
      if (!this._items._check(val[i], cb)) {
        b = false;
      }
    }
    PATH.pop();
  } else {
    for (i = 0, l = val.length; i < l; i++) {
      if (!this._items._check(val[i], cb)) {
        return false;
      }
    }
  }
  return b;
};

ArrayType.prototype._read = function (tap) {
  var items = this._items;
  var val = [];
  var n;
  while ((n = tap.readLong())) {
    if (n < 0) {
      n = -n;
      tap.skipLong(); // Skip size.
    }
    while (n--) {
      val.push(items._read(tap));
    }
  }
  return val;
};

ArrayType.prototype._skip = function (tap) {
  var len, n;
  while ((n = tap.readLong())) {
    if (n < 0) {
      len = tap.readLong();
      tap.pos += len;
    } else {
      while (n--) {
        this._items._skip(tap);
      }
    }
  }
};

ArrayType.prototype._write = function (tap, val) {
  if (!(val instanceof Array)) {
    throwInvalidError(null, val, this);
  }

  var n = val.length;
  var i;
  if (n) {
    tap.writeLong(n);
    for (i = 0; i < n; i++) {
      this._items._write(tap, val[i]);
    }
  }
  tap.writeLong(0);
};

ArrayType.prototype._match = function (tap1, tap2) {
  var n1 = tap1.readLong();
  var n2 = tap2.readLong();
  var f;
  while (n1 && n2) {
    f = this._items._match(tap1, tap2);
    if (f) {
      return f;
    }
    if (!--n1) {
      n1 = readArraySize(tap1);
    }
    if (!--n2) {
      n2 = readArraySize(tap2);
    }
  }
  return utils.compare(n1, n2);
};

ArrayType.prototype._updateResolver = function (resolver, type, opts) {
  if (type instanceof ArrayType) {
    resolver._items = this._items.createResolver(type._items, opts);
    resolver._read = this._read;
  }
};

ArrayType.prototype.clone = function (val, opts) {
  if (val instanceof Array) {
    var itemsType = this._items;
    return val.map(function (elem) { return itemsType.clone(elem, opts); });
  }
  throwInvalidError(null, val, this);
};

ArrayType.prototype.compare = function (val1, val2) {
  var n1 = val1.length;
  var n2 = val2.length;
  var i, l, f;
  for (i = 0, l = Math.min(n1, n2); i < l; i++) {
    if ((f = this._items.compare(val1[i], val2[i]))) {
      return f;
    }
  }
  return utils.compare(n1, n2);
};

ArrayType.prototype.getItemsType = function () { return this._items; };

ArrayType.prototype.random = function () {
  var arr = [];
  var i, l;
  for (i = 0, l = RANDOM.nextInt(10); i < l; i++) {
    arr.push(this._items.random());
  }
  return arr;
};

ArrayType.prototype.toJSON = function () {
  return {type: 'array', items: this._items};
};

/**
 * Avro record.
 *
 * A "specific record class" gets programmatically created for each record.
 * This gives significant speedups over using generics objects (~3 times
 * faster) and provides a custom constructor.
 *
 */
function RecordType(schema, opts) {
  opts = getOpts(schema, opts);

  var resolutions = resolveNames(schema, opts.namespace);
  this._name = resolutions.name;
  this._aliases = resolutions.aliases;
  Type.call(this, opts.registry);

  if (!(schema.fields instanceof Array)) {
    throw new Error(f('non-array %s fields', this._name));
  }
  if (utils.hasDuplicates(schema.fields, function (f) { return f.name; })) {
    throw new Error(f('duplicate %s field name', this._name));
  }
  this._fields = schema.fields.map(function (f) {
    return new Field(f, opts);
  });

  this._constructor = this._createConstructor(schema.type === 'error');
  this._read = this._createReader();
  this._skip = this._createSkipper();
  this._write = this._createWriter();
  this._check = this._createChecker();
}
util.inherits(RecordType, Type);

RecordType.prototype._createConstructor = function (isError) {
  // jshint -W054
  var outerArgs = [];
  var innerArgs = [];
  var ds = []; // Defaults.
  var innerBody = isError ? '  Error.call(this);\n' : '';
  // Not calling `Error.captureStackTrace` because this wouldn't be compatible
  // with browsers other than Chrome.
  var i, l, field, name, getDefault;
  for (i = 0, l = this._fields.length; i < l; i++) {
    field = this._fields[i];
    getDefault = field.getDefault;
    name = field._name;
    innerArgs.push('v' + i);
    innerBody += '  ';
    if (getDefault() === undefined) {
      innerBody += 'this.' + name + ' = v' + i + ';\n';
    } else {
      innerBody += 'if (v' + i + ' === undefined) { ';
      innerBody += 'this.' + name + ' = d' + ds.length + '(); ';
      innerBody += '} else { this.' + name + ' = v' + i + '; }\n';
      outerArgs.push('d' + ds.length);
      ds.push(getDefault);
    }
  }
  var outerBody = 'return function ' + unqualify(this._name) + '(';
  outerBody += innerArgs.join() + ') {\n' + innerBody + '};';
  var Record = new Function(outerArgs.join(), outerBody).apply(undefined, ds);

  var self = this;
  Record.getType = function () { return self; };
  Record.prototype = {
    $clone: function () { return self.clone(this); },
    $compare: function (val) { return self.compare(this, val); },
    $getType: Record.getType,
    $isValid: function (opts) { return self.isValid(this, opts); },
    $toBuffer: function () { return self.toBuffer(this); },
    $toString: function () { return self.toString(this); }
  };
  // The names of these properties added to the prototype are prefixed with `$`
  // because it is an invalid property name in Avro but not in JavaScript.
  // (This way we are guaranteed not to be stepped over!)
  if (isError) {
    util.inherits(Record, Error);
    // Not setting the name on the prototype to be consistent with how object
    // fields are mapped to (only if defined in the schema as a field).
  }

  return Record;
};

RecordType.prototype._createChecker = function () {
  // jshint -W054
  var names = ['t', 'P'];
  var values = [this, PATH];
  var body = 'return function check' + unqualify(this._name) + '(val, cb) {\n';
  body += '  if (val === null || typeof val != \'object\') {\n';
  body += '    if (cb) { cb(P.slice(), val, t); }\n';
  body += '    return false;\n';
  body += '  }\n';
  for (i = 0, l = this._fields.length; i < l; i++) {
    field = this._fields[i];
    names.push('t' + i);
    values.push(field._type);
    if (field.getDefault() !== undefined) {
      body += '  var v' + i + ' = val.' + field._name + ';\n';
    }
  }
  body += '  if (cb) {\n';
  body += '    var b = 1;\n';
  body += '    var j = P.length;\n';
  body += '    P.push(\'\');\n';
  var i, l, field;
  for (i = 0, l = this._fields.length; i < l; i++) {
    field = this._fields[i];
    body += '    P[j] = \'' + field._name + '\';\n';
    if (field.getDefault() === undefined) {
      body += '    b &= t' + i + '._check(val.' + field._name + ', cb);\n';
    } else {
      body += '    b &= v' + i + ' === undefined || ';
      body += 't' + i + '._check(v' + i + ', cb);\n';
    }
  }
  body += '    P.pop();\n';
  body += '    return !!b;\n';
  body += '  } else {\n    return (\n      ';
  body += this._fields.map(function (field, i) {
    if (field.getDefault() === undefined) {
      return 't' + i + '._check(val.' + field._name + ')';
    } else {
      return '(v' + i + ' === undefined || t' + i + '._check(v' + i + '))';
    }
  }).join(' &&\n      ');
  body += '\n    );\n  }\n};';
  return new Function(names.join(), body).apply(undefined, values);
};

RecordType.prototype._createReader = function () {
  // jshint -W054
  var uname = unqualify(this._name);
  var names = [];
  var values = [this._constructor];
  var i, l;
  for (i = 0, l = this._fields.length; i < l; i++) {
    names.push('t' + i);
    values.push(this._fields[i]._type);
  }
  var body = 'return function read' + uname + '(tap) {\n';
  body += '  return new ' + uname + '(';
  body += names.map(function (t) { return t + '._read(tap)'; }).join();
  body += ');\n};';
  names.unshift(uname);
  // We can do this since the JS spec guarantees that function arguments are
  // evaluated from left to right.
  return new Function(names.join(), body).apply(undefined, values);
};

RecordType.prototype._createSkipper = function () {
  // jshint -W054
  var args = [];
  var body = 'return function skip' + unqualify(this._name) + '(tap) {\n';
  var values = [];
  var i, l;
  for (i = 0, l = this._fields.length; i < l; i++) {
    args.push('t' + i);
    values.push(this._fields[i]._type);
    body += '  t' + i + '._skip(tap);\n';
  }
  body += '}';
  return new Function(args.join(), body).apply(undefined, values);
};

RecordType.prototype._createWriter = function () {
  // jshint -W054
  // We still do default handling here, in case a normal JS object is passed.
  var args = [];
  var body = 'return function write' + unqualify(this._name) + '(tap, val) {\n';
  var values = [];
  var i, l, field, value;
  for (i = 0, l = this._fields.length; i < l; i++) {
    field = this._fields[i];
    args.push('t' + i);
    values.push(field._type);
    body += '  ';
    if (field.getDefault() === undefined) {
      body += 't' + i + '._write(tap, val.' + field._name + ');\n';
    } else {
      value = field._type.toBuffer(field.getDefault()).toString('binary');
      // Convert the default value to a binary string ahead of time. We aren't
      // converting it to a buffer to avoid retaining too much memory. If we
      // had our own buffer pool, this could be an idea in the future.
      args.push('d' + i);
      values.push(value);
      body += 'var v' + i + ' = val.' + field._name + '; ';
      body += 'if (v' + i + ' === undefined) { ';
      body += 'tap.writeBinary(d' + i + ', ' + value.length + ');';
      body += ' } else { t' + i + '._write(tap, v' + i + '); }\n';
    }
  }
  body += '}';
  return new Function(args.join(), body).apply(undefined, values);
};

RecordType.prototype._updateResolver = function (resolver, type, opts) {
  // jshint -W054
  if (!~getAliases(this).indexOf(type._name)) {
    throw new Error(f('no alias for %s in %s', type._name, this._name));
  }

  var rFields = this._fields;
  var wFields = type._fields;
  var wFieldsMap = utils.toMap(wFields, function (f) { return f._name; });

  var innerArgs = []; // Arguments for reader constructor.
  var resolvers = {}; // Resolvers keyed by writer field name.
  var i, j, field, name, names, matches;
  for (i = 0; i < rFields.length; i++) {
    field = rFields[i];
    names = getAliases(field);
    matches = [];
    for (j = 0; j < names.length; j++) {
      name = names[j];
      if (wFieldsMap[name]) {
        matches.push(name);
      }
    }
    if (matches.length > 1) {
      throw new Error(f('multiple matches for %s', field.name));
    }
    if (!matches.length) {
      if (field.getDefault() === undefined) {
        throw new Error(f('no match for default-less %s', field.name));
      }
      innerArgs.push('undefined');
    } else {
      name = matches[0];
      resolvers[name] = {
        resolver: field._type.createResolver(wFieldsMap[name]._type, opts),
        name: field._name // Reader field name.
      };
      innerArgs.push(field._name);
    }
  }

  // See if we can add a bypass for unused fields at the end of the record.
  var lazyIndex = -1;
  i = wFields.length;
  while (i && resolvers[wFields[--i]._name] === undefined) {
    lazyIndex = i;
  }

  var uname = unqualify(this._name);
  var args = [uname];
  var values = [this._constructor];
  var body = '  return function read' + uname + '(tap,lazy) {\n';
  for (i = 0; i < wFields.length; i++) {
    if (i === lazyIndex) {
      body += '  if (!lazy) {\n';
    }
    field = type._fields[i];
    name = field._name;
    body += (~lazyIndex && i >= lazyIndex) ? '    ' : '  ';
    if (resolvers[name] === undefined) {
      args.push('t' + i);
      values.push(field._type);
      body += 't' + i + '._skip(tap);\n';
    } else {
      args.push('t' + i);
      values.push(resolvers[name].resolver);
      body += 'var ' + resolvers[name].name + ' = ';
      body += 't' + i + '._read(tap);\n';
    }
  }
  if (~lazyIndex) {
    body += '  }\n';
  }
  body +=  '  return new ' + uname + '(' + innerArgs.join() + ');\n};';

  resolver._read = new Function(args.join(), body).apply(undefined, values);
};

RecordType.prototype._match = function (tap1, tap2) {
  var fields = this._fields;
  var i, l, field, order, type;
  for (i = 0, l = fields.length; i < l; i++) {
    field = fields[i];
    order = field._order;
    type = field._type;
    if (order) {
      order *= type._match(tap1, tap2);
      if (order) {
        return order;
      }
    } else {
      type._skip(tap1);
      type._skip(tap2);
    }
  }
  return 0;
};

RecordType.prototype.clone = function (val, opts) {
  // jshint -W058
  var hook = opts && opts.fieldHook;
  var fields = this._fields.map(function (f) {
    var copy = f._type.clone(val[f._name], opts);
    if (hook) {
      copy = hook(f, copy, this);
    }
    return copy;
  }, this);
  fields.unshift(undefined);
  return new (this._constructor.bind.apply(this._constructor, fields));
};

RecordType.prototype.compare = function (val1, val2) {
  var fields = this._fields;
  var i, l, field, name, order, type;
  for (i = 0, l = fields.length; i < l; i++) {
    field = fields[i];
    name = field._name;
    order = field._order;
    type = field._type;
    if (order) {
      order *= type.compare(val1[name], val2[name]);
      if (order) {
        return order;
      }
    }
  }
  return 0;
};

RecordType.prototype.getAliases = function () { return this._aliases; };

RecordType.prototype.getFields = function () { return this._fields.slice(); };

RecordType.prototype.getFullName = function () { return this._name; };

RecordType.prototype.getRecordConstructor = function () {
  return this._constructor;
};

RecordType.prototype.random = function () {
  // jshint -W058
  var fields = this._fields.map(function (f) { return f._type.random(); });
  fields.unshift(undefined);
  return new (this._constructor.bind.apply(this._constructor, fields));
};

RecordType.prototype.toJSON = function () {
  return {name: this._name, type: 'record', fields: this._fields};
};

/**
 * Schema parsing entry point.
 *
 * It isn't exposed directly but called from `parse` inside `index.js` (node) or
 * `avsc.js` (browserify) which add convenience functionality.
 *
 */
function createType(schema, opts) {
  if (schema instanceof Type) {
    return schema;
  }

  opts = getOpts(schema, opts);

  var type;
  if (typeof schema == 'string') { // Type reference.
    if (opts.namespace && !~schema.indexOf('.') && !isPrimitive(schema)) {
      schema = opts.namespace + '.' + schema;
    }
    type = opts.registry[schema];
    if (type) {
      // Type was already defined, return it.
      return type;
    }
    if (isPrimitive(schema)) {
      // Reference to a primitive type. These are also defined names by default
      // so we create the appropriate type and it to the registry for future
      // reference.
      return opts.registry[schema] = createType({type: schema}, opts);
    }
    throw new Error(f('undefined type name: %s', schema));
  }

  if (opts.typeHook && (type = opts.typeHook(schema, opts))) {
    if (!(type instanceof Type)) {
      throw new Error(f('invalid typehook return value: %j', type));
    }
    return type;
  }

  if (schema instanceof Array) { // Union.
    type = new UnionType(schema, opts);
  } else { // New type definition.
    type = (function (typeName) {
      var Type = TYPES[schema.type];
      if (Type === undefined) {
        throw new Error(f('unknown type: %j', typeName));
      }
      return new Type(schema, opts);
    })(schema.type);
  }
  return type;
}

// General helpers.

/**
 * Field.
 *
 * @param schema {Object} The field's schema.
 * @para opts {Object} Schema parsing options (the same as `Type`s').
 *
 */
function Field(schema, opts) {
  var name = schema.name;
  if (typeof name != 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(f('invalid field name: %s', name));
  }

  this._name = name;
  this._type = createType(schema.type, opts);
  this._aliases = schema.aliases || [];

  this.setOrder(schema.order || 'ascending');

  var value = schema['default'];
  this._default = value; // Save this for schema JSON serialization.
  if (value !== undefined) {
    // We need to convert defaults back to a valid format (unions are
    // disallowed in default definitions, only the first type of each union is
    // allowed instead).
    // http://apache-avro.679487.n3.nabble.com/field-union-default-in-Java-td1175327.html
    var type = this._type;
    var val = type.clone(value, {coerceBuffers: true, wrapUnions: true});
    // The clone call above will throw an error if the default is invalid.
    if (type instanceof PrimitiveType && !(type instanceof BytesType)) {
      // These are immutable.
      this.getDefault = function () { return val; };
    } else {
      this.getDefault = function () { return type.clone(val); };
    }
  }
}

Field.prototype.getAliases = function () { return this._aliases; };

Field.prototype.getDefault = function () {}; // Undefined default.

Field.prototype.getName = function () { return this._name; };

Field.prototype.getOrder = function () {
  return ['descending', 'ignore', 'ascending'][this._order + 1];
};

Field.prototype.setOrder = function (order) {
  var orders = {ascending: 1, ignore: 0, descending: -1};
  if (!orders.hasOwnProperty(order)) {
    throw new Error(f('invalid order: %j', order));
  }
  this._order = orders[order];
};

Field.prototype.getType = function () { return this._type; };

Field.prototype.toJSON = function () {
  return {name: this._name, type: this._type, 'default': this._default};
};

Field.prototype.inspect = Field.prototype.toJSON;

/**
 * Resolver to read a writer's schema as a new schema.
 *
 * @param readerType {Type} The type to convert to.
 *
 */
function Resolver(readerType) {
  // Add all fields here so that all resolvers share the same hidden class.
  this._readerType = readerType;
  this._items = null;
  this._read = null;
  this._size = 0;
  this._symbols = null;
  this._values = null;
}

/**
 * Read a value from a tap.
 *
 * @param type {Type} The type to decode.
 * @param tap {Tap} The tap to read from. No checks are performed here.
 * @param resolver {Resolver} Optional resolver. It must match the input type.
 * @param lazy {Boolean} Skip trailing fields when using a resolver.
 *
 */
function readValue(type, tap, resolver, lazy) {
  if (resolver) {
    if (resolver._readerType !== type) {
      throw new Error('invalid resolver');
    }
    return resolver._read(tap, lazy);
  } else {
    return type._read(tap);
  }
}

/**
 * Create default parsing options.
 *
 * @param schema {Object} Schema to populate options with.
 * @param opts {Object} Base options.
 *
 */
function getOpts(schema, opts) {
  if (schema === null) {
    // Let's be helpful for this common error.
    throw new Error('invalid type: null (did you mean "null"?)');
  }
  opts = opts || {};
  opts.registry = opts.registry || {};
  opts.namespace = schema.namespace || opts.namespace;
  return opts;
}

/**
 * Resolve a schema's name and aliases.
 *
 * @param schema {Object} True schema (can't be a string).
 * @param namespace {String} Optional parent namespace.
 *
 */
function resolveNames(schema, namespace) {
  namespace = schema.namespace || namespace;

  var name = schema.name;
  if (!name) {
    throw new Error(f('missing name in schema: %j', schema));
  }
  return {
    name: qualify(name),
    aliases: schema.aliases ? schema.aliases.map(qualify) : []
  };

  function qualify(name) {
    if (!~name.indexOf('.') && namespace) {
      name = namespace + '.' + name;
    }
    var tail = unqualify(name);
    if (isPrimitive(tail)) {
      // Primitive types cannot be defined in any namespace.
      throw new Error(f('cannot rename primitive type: %s', tail));
    }
    return name;
  }
}

/**
 * Remove namespace from a name.
 *
 * @param name {String} Full or short name.
 *
 */
function unqualify(name) {
  var parts = name.split('.');
  return parts[parts.length - 1];
}

/**
 * Get all aliases for a type (including its name).
 *
 * @param obj {Type|Object} Typically a type or a field. Its aliases property
 * must exist and be an array.
 *
 */
function getAliases(obj) {
  var names = [obj._name];
  var aliases = obj._aliases;
  var i, l;
  for (i = 0, l = aliases.length; i < l; i++) {
    names.push(aliases[i]);
  }
  return names;
}

/**
 * Get a type's "type" (as a string, e.g. `'record'`, `'string'`).
 *
 * @param type {Type} Any type.
 *
 */
function getTypeName(type) {
  var obj = type.toJSON();
  return typeof obj == 'string' ? obj : obj.type;
}

/**
 * Check whether a type's name is a primitive.
 *
 * @param name {String} Type name (e.g. `'string'`, `'array'`).
 *
 */
function isPrimitive(name) {
  var type = TYPES[name];
  return type !== undefined && type.prototype instanceof PrimitiveType;
}

/**
 * Get the number of elements in an array block.
 *
 * @param tap {Tap} A tap positioned at the beginning of an array block.
 *
 */
function readArraySize(tap) {
  var n = tap.readLong();
  if (n < 0) {
    n = -n;
    tap.skipLong(); // Skip size.
  }
  return n;
}

/**
 * Try cloning an object to a buffer.
 *
 * @param obj {Object} Object to copy to a buffer.
 * @param coerce {Boolean} Allow some conversions to buffers.
 *
 */
function tryCloneBuffer(obj, coerce) {
  if (Buffer.isBuffer(obj)) {
    // Check this first (should be most common case).
    return new Buffer(obj);
  }
  if (coerce) {
    if (typeof obj == 'string') {
      return new Buffer(obj, 'binary');
    } else if (obj.type === 'Buffer' && obj.data instanceof Array) {
      return new Buffer(obj.data);
    }
  }
  return obj;
}

/**
 * Check whether a long can be represented without precision loss.
 *
 * @param n {Number} The number.
 *
 * Two things to note:
 *
 * + We are not using the `Number` constants for compatibility with older
 *   browsers.
 * + We must remove one from each bound because of rounding errors.
 *
 */
function isSafeLong(n) {
  return n >= -9007199254740990 && n <= 9007199254740990;
}

/**
 * Throw a somewhat helpful error on invalid object.
 *
 * @param path {Array} Passed from hook, but unused (because empty where this
 * function is used, since we aren't keeping track of it for effiency).
 * @param val {...} The object to reject.
 * @param type {Type} The type to check against.
 *
 * This method is mostly used from `_write` to signal an invalid object for a
 * given type. Note that this provides less information than calling `isValid`
 * with a hook since the path is not propagated (for efficiency reasons).
 *
 */
function throwInvalidError(path, val, type) {
  throw new Error(f('invalid %s: %j', type, val));
}


module.exports = {
  createType: createType,
  types: (function () {
    // Export the base type along with all concrete implementations.
    var obj = {Type: Type};
    var types = Object.keys(TYPES);
    var i, l, Class;
    for (i = 0, l = types.length; i < l; i++) {
      Class = TYPES[types[i]];
      obj[Class.name] = Class;
    }
    return obj;
  })()
};