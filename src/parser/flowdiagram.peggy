Document
  = (_ NL)* _ "@startuml" _ NL body:Body _ "@enduml" (_ NL)* _
  { return body; }

Body
  = entries:Entry*
  {
    const components = [];
    const connections = [];
    const flows = [];
    const groups = [];
    const stages = [];
    const positions = {};
    const settings = {};
    // Deferred references: each entry is { parentId, refId }. Resolved
    // after all declarations so forward references work.
    const referenceRequests = [];

    // Recursively walk packages, tagging each component with its direct
    // parent group and each nested group with its parent group.
    function ingestPackage(pkg, parentGroupId) {
      const childIds = [];
      let collapseAtPx = undefined;
      let defaultOpen = undefined;

      for (const child of pkg.entries) {
        if (!child) continue;
        if (child.type === 'component') {
          components.push({ ...child, parentGroup: pkg.id });
          childIds.push(child.id);
        } else if (child.type === 'connection') {
          connections.push(child);
        } else if (child.type === 'flow') {
          flows.push(child);
        } else if (child.type === 'package') {
          childIds.push(child.id);
          ingestPackage(child, pkg.id);
        } else if (child.type === 'packageRef') {
          // Defer — the referenced package may be declared later.
          referenceRequests.push({ parentId: pkg.id, refId: child.id });
        } else if (child.type === 'packageProp') {
          if (child.key === 'collapse_at') collapseAtPx = child.value;
          else if (child.key === 'open') defaultOpen = child.value;
        }
      }

      groups.push({
        id: pkg.id,
        displayName: pkg.displayName,
        color: pkg.color,
        children: childIds,
        parentGroup: parentGroupId,
        collapseAtPx,
        defaultOpen,
        loc: pkg.loc,
      });
    }

    function ingest(entry) {
      if (!entry) return;
      if (entry.type === 'component') components.push(entry);
      else if (entry.type === 'connection') connections.push(entry);
      else if (entry.type === 'flow') flows.push(entry);
      else if (entry.type === 'package') ingestPackage(entry, undefined);
      else if (entry.type === 'stage') {
        // Tag each flow with its stage name and push to global flows.
        const flowNames = [];
        for (const flow of entry.flows) {
          flow.stage = entry.name;
          flows.push(flow);
          flowNames.push(flow.name);
        }
        stages.push({
          name: entry.name,
          after: entry.after,
          repeat: entry.repeat,
          color: entry.color,
          flowNames,
          loc: entry.loc,
        });
      }
      else if (entry.type === 'positions') {
        for (const p of entry.entries) {
          if (p) positions[p.id] = { x: p.x, y: p.y };
        }
      }
      else if (entry.type === 'setting') {
        settings[entry.key] = entry.value;
      }
    }

    for (const entry of entries) ingest(entry);

    // Resolve references. A package referenced by another becomes a child
    // of that other; its previous parent (often root) drops it.
    const groupById = new Map(groups.map(g => [g.id, g]));
    for (const { parentId, refId } of referenceRequests) {
      const refGroup = groupById.get(refId);
      if (!refGroup) {
        throw new Error(`Package reference to unknown package "${refId}" inside "${parentId}"`);
      }
      // Update the referenced group's parent AND register it under the
      // new parent's children list (unless already present).
      refGroup.parentGroup = parentId;
      const parentGroup = groupById.get(parentId);
      if (parentGroup && !parentGroup.children.includes(refId)) {
        parentGroup.children.push(refId);
      }
      // Cascade: components whose parentGroup is the referenced group
      // stay pointing at that group. Nothing else changes — the tree
      // rearranges via parentGroup pointers only.
    }

    return { components, connections, flows, groups, stages, positions, settings };
  }

// Entry handles newlines: single-line statements consume one NL,
// block constructs (FlowBlock, PositionsBlock, Package, StageBlock)
// handle their own NLs.
Entry
  = pkg:Package { return pkg; }
  / stage:StageBlock { return stage; }
  / pb:PositionsBlock { return pb; }
  / fb:FlowBlock { return fb; }
  / setting:DiagramSetting { return setting; }
  / _ stmt:(Component / Connection / Comment) _ NL { return stmt; }
  / _ NL { return null; }

// --- Diagram-wide settings ---
// Top-level property lines that set defaults for the whole diagram.
// arrival_effect: dissolve | outline | none — default arrival effect for
// every flow (each flow may override with its own `effect:`).

DiagramSetting
  = _ "arrival_effect:" _ value:EffectKind _ NL
  { return { type: 'setting', key: 'arrivalEffect', value }; }
  / _ "trail:" _ value:BoolValue _ NL
  { return { type: 'setting', key: 'trail', value }; }

EffectKind
  = "dissolve" { return 'dissolve'; }
  / "outline"  { return 'outline'; }
  / "ripple"   { return 'ripple'; }
  / "fill"     { return 'fill'; }
  / "sparks"   { return 'sparks'; }
  / "none"     { return 'none'; }

// --- Stage ---
// Groups flows into a stage. Stage lifecycle: idle → running → completed.
// - Runs immediately if it has no `after:` deps (unless others pin it via deps).
// - Runs when every `after:` stage has a fresh completion available.
// - Each flow inside fires once per stage run, unless it has `every:`/`freq:`
//   (then it loops while the stage is running).
// - `repeat: true` restarts the stage after completion.
//
// @stage name
//   after: other_stage_a, other_stage_b
//   repeat: true
//   @flow ...
// @end_stage

StageBlock
  = _ "@stage" WS+ name:Alias _ NL
    parts:StagePart*
    _ "@end_stage" _ NL
  {
    const stage = { type: 'stage', name, after: [], repeat: false, color: undefined, flows: [], loc: { start: location().start.offset, end: location().end.offset } };
    for (const part of parts) {
      if (!part) continue;
      if (part.type === 'flow') stage.flows.push(part);
      else if (part.key === 'after') stage.after = part.value;
      else if (part.key === 'repeat') stage.repeat = part.value;
      else if (part.key === 'color') stage.color = part.value;
    }
    return stage;
  }

StagePart
  = fb:FlowBlock { return fb; }
  / _ "after:" _ value:AfterList _ NL { return { key: 'after', value }; }
  / _ "repeat:" _ value:BoolValue _ NL { return { key: 'repeat', value }; }
  / _ "color:" _ value:ColorSpec _ NL { return { key: 'color', value }; }
  / _ Comment NL { return null; }
  / _ NL { return null; }

BoolValue
  = "true"  { return true; }
  / "false" { return false; }

// --- Package (group) ---
// Packages may contain components, connections, flows, NESTED packages,
// and a `collapse_at: Npx` property line.
//
// package "Display Name" as alias {
//   collapse_at: 180px
//   component ...
//   package "Nested" as nested {
//     component ...
//   }
//   @flow ...
// }

Package
  = _ "package" WS+ displayName:QuotedString WS+ "as" WS+ id:Alias color:(_ "#" ColorValue)? _ "{" _ NL
    entries:PackageEntry*
    _ "}" _ NL
  {
    return {
      type: 'package',
      id,
      displayName,
      color: color ? color[2] : undefined,
      entries,
      loc: { start: location().start.offset, end: location().end.offset },
    };
  }

PackageEntry
  = pkg:Package { return pkg; }
  / ref:PackageRef { return ref; }
  / prop:PackageProp { return prop; }
  / fb:FlowBlock { return fb; }
  / _ stmt:(Component / Connection / Comment) _ NL { return stmt; }
  / _ NL { return null; }

// Reference form: `package <alias>` — pull a previously or later-declared
// package into this package's subtree. Has NO quoted string and NO braces,
// which disambiguates it from a Package declaration.
PackageRef
  = _ "package" WS+ id:Alias _ NL
  { return { type: 'packageRef', id }; }

// Package-level properties.
// `open: true` — the package starts expanded instead of as a closed
// layer box. `collapse_at:` is a legacy no-op (zoom-based auto-collapse
// was replaced by click-to-open layers); still parsed so old files load.
PackageProp
  = _ "open:" _ value:BoolValue _ NL
  { return { type: 'packageProp', key: 'open', value }; }
  / _ "collapse_at:" _ value:PixelValue _ NL
  { return { type: 'packageProp', key: 'collapse_at', value }; }

PixelValue
  = n:Number "px"
  { return n; }
  / n:Number
  { return n; }

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
      loc: { start: location().start.offset, end: location().end.offset },
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
      loc: { start: location().start.offset, end: location().end.offset },
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
      loc: { start: location().start.offset, end: location().end.offset },
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
      speedPxPerSec: undefined,
      startDelayMs: 0,
      direction: 'forward',
      color: undefined,
      after: [],
      hasRate: false,
    };
    let sawTraverse = false;
    for (const prop of properties) {
      if (!prop) continue;
      if (prop.key === 'data') result.data = prop.value;
      else if (prop.key === 'freq') {
        const perSecond = prop.value.unit === 's' ? prop.value.value : prop.value.value / 60;
        result.intervalMs = 1000 / Math.max(perSecond, 0.001);
        result.hasRate = true;
      }
      else if (prop.key === 'every') {
        result.intervalMs = durationToMs(prop.value);
        result.hasRate = true;
      }
      else if (prop.key === 'traverse_time') { result.traverseTimeMs = durationToMs(prop.value); sawTraverse = true; }
      else if (prop.key === 'speed') result.speedPxPerSec = prop.value;
      else if (prop.key === 'start_delay') result.startDelayMs = durationToMs(prop.value);
      else if (prop.key === 'direction') result.direction = prop.value;
      else if (prop.key === 'color') result.color = prop.value;
      else if (prop.key === 'after') result.after = prop.value;
      else if (prop.key === 'effect') result.arrivalEffect = prop.value;
      else if (prop.key === 'trail') result.trail = prop.value;
    }
    // Constant speed is the default model: unless the author wrote an
    // explicit traverse_time:, dots move at a uniform px/s pace.
    if (!sawTraverse && result.speedPxPerSec === undefined) result.speedPxPerSec = 150;
    result.loc = { start: location().start.offset, end: location().end.offset };
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
  / _ "speed:" _ value:Number ("px/s")? _ NL
  { return { key: 'speed', value }; }
  / _ "start_delay:" _ value:EveryValue _ NL
  { return { key: 'start_delay', value }; }
  / _ "direction:" _ value:Direction _ NL
  { return { key: 'direction', value }; }
  / _ "color:" _ value:ColorSpec _ NL
  { return { key: 'color', value }; }
  / _ "after:" _ value:AfterList _ NL
  { return { key: 'after', value }; }
  / _ "arrival_effect:" _ value:EffectKind _ NL
  { return { key: 'effect', value }; }
  / _ "effect:" _ value:EffectKind _ NL
  { return { key: 'effect', value }; }  // legacy alias for arrival_effect:
  / _ "trail:" _ value:BoolValue _ NL
  { return { key: 'trail', value }; }
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
