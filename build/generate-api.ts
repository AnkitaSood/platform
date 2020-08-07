import { writeFileSync } from 'fs';
import {
  Project,
  ExportedDeclarations,
  MethodDeclaration,
  SourceFile,
  Node,
} from 'ts-morph';
import { format, resolveConfig, Options as PrettierOptions } from 'prettier';

const signatures = {
  ClassDeclaration: formatClassDeclaration,
  FunctionDeclaration: formatFunctionDeclaration,
  VariableDeclaration: formatVariableDeclaration,
  InterfaceDeclaration: formatInterfaceDeclaration,
  TypeAliasDeclaration: formatTypeAliasDeclaration,
  EnumDeclaration: formatEnumDeclaration,
} as {
  [key: string]: (declaration: ExportedDeclarations) => string;
};

generateApi();

function generateApi() {
  const files = getBarrelFiles();
  const output = files
    .map(generateApiForFile)
    .reduce((acc, file) => acc.concat(file), []);
  const formattedOutput = prettier(JSON.stringify(output), 'json');
  writeFileSync('./output.json', formattedOutput, 'utf-8');
}

function getBarrelFiles() {
  const project = new Project();
  project.addSourceFilesAtPaths('./modules/*/index.ts');
  const files = project.getSourceFiles();
  return files;
}

function generateApiForFile(sourceFile: SourceFile) {
  const module = sourceFile.getDirectory().getBaseName();
  const exportDeclarations = sourceFile.getExportedDeclarations();

  const fileOutput: Output[] = [];
  const entries = exportDeclarations.entries();
  let entry: IteratorResult<[string, ExportedDeclarations[]]>;
  while ((entry = entries.next())) {
    if (entry.done) break;
    const [key, declarations] = entry.value;
    fileOutput.push({
      module,
      api: key,
      kind: declarations[0].getKindName(),
      // declaration can have overloads
      // iterate over each overload to document all declarations
      signatures: declarations.map((d) => {
        const formatter =
          signatures[d.getKindName()] ||
          ((declaration) => getText(declaration));
        const signature = formatter(d);
        // a FunctionDeclaration isn't valid
        if (d.getKindName() === 'FunctionDeclaration') {
          return signature;
        }
        return prettier(signature, 'typescript');
      }),
      information: getInformation(declarations[0]),
    });
  }

  return fileOutput;
}

/**
 * Use prettier to format code, will throw if code isn't correct
 */
function prettier(
  code: string,
  parser: PrettierOptions['parser'] = 'typescript'
) {
  const prettierConfig = resolveConfig.sync(__dirname);
  const prettyfied = format(code, {
    parser,
    ...prettierConfig,
  });
  return prettyfied;
}

function getInformation(declaration: ExportedDeclarations) {
  if (
    !Node.isFunctionDeclaration(declaration) &&
    !Node.isInterfaceDeclaration(declaration) &&
    !Node.isEnumDeclaration(declaration) &&
    !Node.isTypeAliasDeclaration(declaration) &&
    !Node.isClassDeclaration(declaration)
  ) {
    return [];
  }

  const docs = declaration.getJsDocs();
  let tagIndex = -1;
  const information: string[][] = [];

  // manually parse the jsDoc tags
  // ts-morph doesn't handle multi line tag text?
  for (const doc of docs) {
    const text = getText(doc);
    const lines = text
      .split('\n')
      // remove the first line /**
      .filter((_, i) => i > 0)
      // remove the leading *
      .map((l) => l.trim().substr(2));

    for (const line of lines) {
      // we hit a tag, create a new entry
      if (line.startsWith('@')) {
        let [tagName, ...lineText] = line.substr(1).split(' ');
        information[++tagIndex] = [tagName];
        // if the line includes the tag description add it
        if (lineText.length) {
          information[tagIndex].push(lineText.join(' '));
        }
      } else if (information[tagIndex]) {
        // append text to the current tag
        information[tagIndex].push(line);
      } else {
        // doc without tag, or text above the first tag
        information[++tagIndex] = ['info', line];
      }
    }
  }

  // remove empty lines at the end of a tag
  for (const tag of information) {
    while (tag[tag.length - 1] === '') {
      tag.length -= 1;
    }
  }

  return information;
}

function formatFunctionDeclaration(declaration: ExportedDeclarations) {
  if (!Node.isFunctionDeclaration(declaration)) {
    throw Error('Declaration is not a function');
  }

  // we don't want implementation details to be leaked into the API docs
  // for now, removing the body is the simplest thing to do
  // another option would be to generate the signature
  // this would allow us to add links to other API docs?
  declaration.removeBody();
  const signature = getText(declaration).replace('export function', '');
  return removeDoubleSpacesAndLineBreaks(signature).trim();
}

function formatClassDeclaration(declaration: ExportedDeclarations) {
  if (!Node.isClassDeclaration(declaration)) {
    throw Error('Declaration is not a class');
  }

  // build the class signature
  let classNameText = declaration.getName();

  const typesText = declaration
    .getTypeParameters()
    .map((p) => removeDoubleSpacesAndLineBreaks(getText(p)))
    .join(', ');

  const extendsText = removeDoubleSpacesAndLineBreaks(
    getText(declaration.getExtends())
  );

  const implementsText = declaration
    .getImplements()
    .map((impl) => removeDoubleSpacesAndLineBreaks(getText(impl)))
    .join(', ');

  const propertiesText = declaration
    .getProperties()
    .filter((p) => p.getScope() === 'public')
    .map((p) => getText(p))
    .join('\n');

  const methodsText = declaration
    .getMethods()
    .map(formatMethodText)
    .filter(Boolean)
    .join('\n');

  // concat class parts to build the signature
  let signature = `class ${classNameText}`;

  if (typesText) {
    signature += `<${typesText}>`;
  }

  if (extendsText) {
    signature += ` extends ${extendsText}`;
  }

  if (implementsText) {
    signature += ` implements ${implementsText}`;
  }

  if (methodsText || propertiesText) {
    signature += ` {`;

    if (propertiesText) {
      signature += `\n${propertiesText}\n`;
    }

    if (methodsText) {
      signature += `\n${methodsText}\n`;
    }
    signature += '\n}';
  } else {
    signature += ' { }';
  }

  return signature.trim();

  function formatMethodText(method: MethodDeclaration) {
    // if a method doesn't have a scope, ts-morph returns `public`
    if (method.getScope() !== 'public') return;

    // here again, we could build the signature ourselves
    // removing the body and the inline comments is simpler for now
    method.removeBody();
    return getText(method);
  }
}

function formatVariableDeclaration(declaration: ExportedDeclarations) {
  if (!Node.isVariableDeclaration(declaration)) {
    throw Error('Declaration is not a variable');
  }

  const nameText = declaration.getName();
  const typeText = declaration
    .getType()
    .getText(declaration)
    .replace('\r\n', '\n');

  return `const ${nameText}: ${typeText}`;
}

function formatTypeAliasDeclaration(declaration: ExportedDeclarations) {
  if (!Node.isTypeAliasDeclaration(declaration)) {
    throw Error('Declaration is not a type alias');
  }

  return getText(declaration).replace('export', '').trim();
}

function formatEnumDeclaration(declaration: ExportedDeclarations) {
  if (!Node.isEnumDeclaration(declaration)) {
    throw Error('Declaration is not an enum');
  }

  // keep enum as is
  // this also adds the comments, do we want this?
  return getText(declaration);
}

function formatInterfaceDeclaration(declaration: ExportedDeclarations) {
  if (!Node.isInterfaceDeclaration(declaration)) {
    throw Error('Declaration is not an interface');
  }

  const interfaceNameText = declaration.getName();

  const typesText = declaration
    .getTypeParameters()
    .map((p) => removeDoubleSpacesAndLineBreaks(getText(p)))
    .join(', ');

  const ownPropertiesText = declaration
    .getProperties()
    .map((p) => removeDoubleSpacesAndLineBreaks(getText(p)));

  // should this be recursive?
  const extendedPropertiesText = declaration
    .getBaseDeclarations()
    .map((b) =>
      Node.isInterfaceDeclaration(b)
        ? [
            ``,
            `// inherited from ${b.getName()}`,
            ...b
              .getProperties()
              .map((p) => removeDoubleSpacesAndLineBreaks(getText(p))),
          ]
        : []
    )
    .reduce((props, prop) => props.concat(prop), []);

  const propertiesText = ownPropertiesText
    .concat(extendedPropertiesText)
    .join('\n');

  // concat interface parts to build the signature
  let signature = `interface ${interfaceNameText}`;

  if (typesText) {
    signature += `<${typesText}>`;
  }

  if (propertiesText) {
    signature += ` {\n${propertiesText}\n}`;
  } else {
    signature += ' {}';
  }

  return signature;
}

function removeDoubleSpacesAndLineBreaks(text: string, replacer = ' ') {
  return text.replace(/\s\s+/g, replacer);
}

function getText(node: Node) {
  return (
    node
      ?.getText()
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((p) => !p.trimLeft().startsWith('//'))
      .map((p) => {
        const comment = p.indexOf('//');
        return comment === -1 ? p : p.substr(0, comment);
      })
      .join('\n') ?? ''
  );
}

interface Output {
  module: string;
  api: string;
  kind: string;
  signatures: string[];
  information: string[][];
}
