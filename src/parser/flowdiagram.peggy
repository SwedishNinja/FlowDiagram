Document
  = _ "@startuml" _ NL body:Body _ "@enduml" _ NL? _
  { return body; }

Body
  = entries:Entry*
  {
    const components = [];
    const connections = [];
    const flows = [];
    const groups = [];
    const positions = {};

    function ingest(entry) {
      if (!entry) return;
      if (entry.type === 'component') components.push(entry);
      else if (entry.type === 'connection') connections.push(entry);
      else if (entry.type === 'flow') flows.push(entry);
      else if (entry.type === 'package') {
        // Tag the package's components with their parent group, then flatten.
        const childIds = [];
        for (const child of entry.entries) {
          if (!child) continue;
          if (child.type === 'component') {
            components.push({ ...child, parentGroup: entry.id });
            childIds.push(child.id);
          } else if (child.type === 'connection') {
            connections.push(child);
          } else if (child.type === 'flow') {
            flows.push(child);
          }
        }
        groups.push({ id: entry.id, displayName: entry.displayName, children: childIds });
      }
      else if (entry.type === 'positions') {
        for (const p of entry.entries) {
          if (p) positions[p.id] = { x: p.x, y: p.y };
        }
      }
    }

    for (const entry of entries) ingest(entry);
    return { components, connections, flows, groups, positions };
  }

// Entry handles newlines: single-line statements consume one NL,
// block constructs (FlowBlock, PositionsBlock, Package) handle their own NLs.
Entry
  = pkg:Package { return pkg; }
  / pb:PositionsBlock { return pb; }
  / fb:FlowBlock { return fb; }
  / _ stmt:(Component / Connection / Comment) _ NL { return stmt; }
  / _ NL { return null; }

// --- Package (group) ---
// package "Display Name" as alias {
//   component ...
//   connection ...
//   @flow ...
// }

Package
  = _ "package" WS+ displayName:QuotedString WS+ "as" WS+ id:Alias _ "{" _ NL
    entries:PackageEntry*
    _ "}" _ NL
  {
    return { type: 'package', id, displayName, entries };
  }

PackageEntry
  = fb:FlowBlock { return fb; }
  / _ stmt:(Component / Connection / Comment) _ NL { return stmt; }
  / _ NL { return null; }

// --- Components ---

Component
  = "component" WS+ displayName:QuotedString WS+ "as" WS+ id:Alias color:(_ "#" ColorValue)? stereotype:(_ Stereotype)?
  {
    return {
      type: 'component',
      id,
      displayName,
      color: color ? color[2] : undefined,
      stereotype: stereotype ? stereotype[1] : undefined,
    };
  }
  / "[" displayName:BracketName "]" WS+ "as" WS+ id:Alias color:(_ "#" ColorValue)? stereotype:(_ Stereotype)?
  {
    return {
      type: 'component',
      id,
      displayName,
      color: color ? color[2] : undefined,
      stereotype: stereotype ? stereotype[1] : undefined,
    };
  }

// --- Connections ---

Connection
  = source:Alias WS+ arrow:Arrow WS+ target:Alias nameClause:(WS+ "as" WS+ Alias)? labelClause:(_ ":" _ ConnectionLabel)?
  {
    let lineStyle = 'solid';
    let arrowStyle = 'forward';
    if (arrow === '..>') lineStyle = 'dotted';
    if (arrow === '<->') arrowStyle = 'bidirectional';
    if (arrow === '-->') arrowStyle = 'long';

    const id = nameClause ? nameClause[3] : undefined;
    const label = labelClause ? labelClause[3] : undefined;

    return {
      type: 'connection',
      id,
      source,
      target,
      label,
      lineStyle,
      arrowStyle,
    };
  }

Arrow
  = "<->" / "-->" / "..>" / "->"

ConnectionLabel
  = chars:[^\n\r]+
  { return chars.join('').trim(); }

// --- Flow Blocks ---

// FlowBlock is a multi-line construct: header line + indented property lines.
// It consumes all its own newlines.
FlowBlock
  = _ "@flow" WS+ name:Alias WS+ "on" WS+ connection:Alias _ NL properties:FlowProperty*
  {
    function durationToMs(d) {
      if (d.unit === 'ms') return d.value;
      if (d.unit === 's') return d.value * 1000;
      if (d.unit === 'm') return d.value * 60000;
      return d.value;
    }
    const result = {
      type: 'flow',
      name,
      connection,
      data: undefined,
      intervalMs: 1000,
      traverseTimeMs: 1500,
      startDelayMs: 0,
      direction: 'forward',
      color: undefined,
      after: [],
    };
    for (const prop of properties) {
      if (!prop) continue;
      if (prop.key === 'data') result.data = prop.value;
      else if (prop.key === 'freq') {
        const perSecond = prop.value.unit === 's' ? prop.value.value : prop.value.value / 60;
        result.intervalMs = 1000 / Math.max(perSecond, 0.001);
      }
      else if (prop.key === 'every') result.intervalMs = durationToMs(prop.value);
      else if (prop.key === 'traverse_time') result.traverseTimeMs = durationToMs(prop.value);
      else if (prop.key === 'start_delay') result.startDelayMs = durationToMs(prop.value);
      else if (prop.key === 'direction') result.direction = prop.value;
      else if (prop.key === 'color') result.color = prop.value;
      else if (prop.key === 'after') result.after = prop.value;
    }
    return result;
  }

FlowProperty
  = _ "data:" _ value:QuotedString _ NL
  { return { key: 'data', value }; }
  / _ "freq:" _ value:FreqValue _ NL
  { return { key: 'freq', value }; }
  / _ "every:" _ value:EveryValue _ NL
  { return { key: 'every', value }; }
  / _ "traverse_time:" _ value:EveryValue _ NL
  { return { key: 'traverse_time', value }; }
  / _ "start_delay:" _ value:EveryValue _ NL
  { return { key: 'start_delay', value }; }
  / _ "direction:" _ value:Direction _ NL
  { return { key: 'direction', value }; }
  / _ "color:" _ value:ColorSpec _ NL
  { return { key: 'color', value }; }
  / _ "after:" _ value:AfterList _ NL
  { return { key: 'after', value }; }
  / _ Comment NL
  { return null; }

ColorSpec
  = "#" chars:[a-zA-Z0-9]+ { return '#' + chars.join(''); }
  / '"' chars:[^"]+ '"' { return chars.join(''); }
  / chars:[a-zA-Z]+ { return chars.join(''); }

// --- Positions Block ---
// @positions
//   alias: x, y
//   alias: x, y

PositionsBlock
  = _ "@positions" _ NL entries:PositionEntry*
  {
    return { type: 'positions', entries };
  }

PositionEntry
  = _ id:Alias _ ":" _ x:SignedNumber _ "," _ y:SignedNumber _ NL
  { return { id, x, y }; }
  / _ Comment NL
  { return null; }

SignedNumber
  = sign:"-"? n:Number
  { return sign ? -n : n; }

Direction
  = "reverse" { return 'reverse'; }
  / "forward" { return 'forward'; }

FreqValue
  = value:Number "/" unit:TimeUnit
  { return { value, unit }; }

EveryValue
  = value:Number unit:DurationUnit
  { return { value, unit }; }

DurationUnit
  = "ms" / "s" / "m"

AfterList
  = head:Alias tail:(_ "," _ Alias)*
  { return [head, ...tail.map(t => t[3])]; }

TimeUnit
  = "s" / "m"

// --- Primitives ---

Alias
  = head:[a-zA-Z_] tail:[a-zA-Z0-9_]*
  { return head + tail.join(''); }

QuotedString
  = '"' chars:[^"]* '"'
  { return chars.join(''); }

BracketName
  = chars:[^\]]+
  { return chars.join('').trim(); }

ColorValue
  = chars:[a-zA-Z0-9]+
  { return chars.join(''); }

Stereotype
  = "<<" chars:[^>]+ ">>"
  { return chars.join('').trim(); }

Number
  = digits:[0-9]+ decimal:("." [0-9]+)?
  {
    const num = digits.join('');
    if (decimal) return parseFloat(num + '.' + decimal[1].join(''));
    return parseInt(num, 10);
  }

// --- Comments and whitespace ---

Comment
  = "'" [^\n\r]*
  { return null; }
  / "/'" (!"'/" .)* "'/"
  { return null; }

NL "newline"
  = "\r\n" / "\n" / "\r"

WS "whitespace"
  = [ \t]

_ "optional whitespace"
  = [ \t]*
