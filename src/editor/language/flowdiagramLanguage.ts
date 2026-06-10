import { LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';

/** Simple stream-based syntax highlighting for the FlowDiagram DSL */
const flowdiagramParser: StreamParser<{ inFlow: boolean }> = {
  startState() {
    return { inFlow: false };
  },
  token(stream, state) {
    // Skip whitespace
    if (stream.eatSpace()) return null;

    // Single-line comments
    if (stream.match("'")) {
      stream.skipToEnd();
      return 'comment';
    }

    // Multi-line comment start
    if (stream.match("/'")) {
      while (!stream.match("'/")) {
        if (stream.next() == null) break;
      }
      return 'comment';
    }

    // Keywords
    if (stream.match('@startuml') || stream.match('@enduml')) {
      return 'keyword';
    }

    // Flow block header
    if (stream.match('@flow')) {
      state.inFlow = true;
      return 'keyword';
    }

    // Component keyword
    if (stream.match('component')) {
      return 'keyword';
    }

    // Package keyword (groups)
    if (stream.match('package')) {
      return 'keyword';
    }

    // Flow property keywords
    if (state.inFlow) {
      if (stream.match('data:') || stream.match('freq:') || stream.match('every:') || stream.match('traverse_time:') || stream.match('speed:') || stream.match('start_delay:') || stream.match('direction:') || stream.match('color:') || stream.match('after:')) {
        return 'propertyName';
      }
      if (stream.match('on')) {
        return 'keyword';
      }
    }

    // "as" keyword
    if (stream.match(/^as(?=\s)/)) {
      return 'keyword';
    }

    // Arrows
    if (stream.match('<->') || stream.match('-->') || stream.match('..>') || stream.match('->')) {
      return 'operator';
    }

    // Quoted strings
    if (stream.match('"')) {
      while (!stream.eat('"')) {
        if (stream.next() == null) break;
      }
      return 'string';
    }

    // Numbers (for freq values)
    if (stream.match(/^\d+(\.\d+)?/)) {
      return 'number';
    }

    // Bracket shorthand [Name]
    if (stream.eat('[')) {
      while (!stream.eat(']')) {
        if (stream.next() == null) break;
      }
      return 'string';
    }

    // Stereotype <<name>>
    if (stream.match('<<')) {
      while (!stream.match('>>')) {
        if (stream.next() == null) break;
      }
      return 'meta';
    }

    // Color #hex
    if (stream.eat('#')) {
      stream.match(/^[a-zA-Z0-9]+/);
      return 'color';
    }

    // Frequency units
    if (stream.match(/^\/[sm]/)) {
      return 'unit';
    }

    // Default: consume one character
    stream.next();

    // Reset flow state on blank line / new non-indented content
    if (stream.sol() && !stream.match(/^\s/, false)) {
      state.inFlow = false;
    }

    return null;
  },
};

const streamLang = StreamLanguage.define(flowdiagramParser);

export function flowdiagramLanguageSupport() {
  return new LanguageSupport(streamLang);
}
