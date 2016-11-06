const fs = require("fs");
const path = require("path");
const esprima = require('esprima');
const escodegen = require('escodegen');

const INLINE_MACRO = /^([\t ]*)(\S.*)?%inline\s*\(\s*['"]([^"']+)["']\s*\)\s*\.(\w+)\s*\(([\s\S]*?)\);$/gm;

/**
 * This function walks the given module AST and tries to locate all the
 * functions it exports.
 *
 * @param {Object} ast - The AST as parsed by esprima
 * @returns {Object} Returns a key/value object with the names and the AST of all exported functions
 */
function getExportedFunctions(ast) {
  var functions =  ast.body.reduce(function(scopeFunctions, node) {

    //
    // Look for ES6 `export` functions
    //
    // export function name(a,b,c) {
    //   ...
    // }
    //
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration.type === 'FunctionDeclaration') {
        scopeFunctions[node.declaration.id.name] = {
          exported: true,
          ast: node.declaration
        };
      }
      return scopeFunctions;
    }

    //
    // Look for regular function declarations
    //
    // function name(a,b,c) {
    //   ...
    // }
    //
    if (node.type === 'FunctionDeclaration') {
      scopeFunctions[node.id.name] = {
        exported: false,
        ast: node
      };
      return scopeFunctions;
    }

    //
    // Look for variable-defined function declarations
    //
    // var name = function(a,b,c) {
    //   ...
    // }
    //
    if (node.type === 'VariableDeclaration') {
      node.declarations.forEach(function(node) {
        if (node.init.type === 'FunctionExpression') {
          scopeFunctions[node.id.name] = {
            exported: false,
            ast: node.init
          };
        }
      });
      return scopeFunctions;
    }

    //
    // Look for default-class export with static functions
    //
    // export default class {
    //    static name(a,b,c) {
    //       ...
    //    }
    // }
    //
    if ((node.type === 'ExportDefaultDeclaration') &&
        (node.declaration.type === 'ClassDeclaration')) {

      node.declaration.body.body.forEach(function(node) {
        if ((node.type === 'MethodDefinition') && node.static) {
          scopeFunctions[node.key.name] = {
            exported: true,
            ast: node.value
          };
        }
      });

      return scopeFunctions;
    }

    //
    // Look for CommonJs exports
    //
    // module.exports = {
    //    name: function(a,b,c) {
    //      ...
    //    },
    //    name(a,b,c) {
    //      ...
    //    },
    //    reference_to_other_function
    // }
    //
    if ((node.type === 'ExpressionStatement') &&
        (node.expression.left.type === 'MemberExpression') &&
        (node.expression.left.object.name === 'module') &&
        (node.expression.left.property.name === 'exports') &&
        (node.expression.right.type === 'ObjectExpression')) {

      node.expression.right.properties.forEach(function(node) {
        var name = node.key.name;
        var value = node.value;

        // Mark reference to declared functions as exported
        if ((value.type === 'Identifier') && (scopeFunctions[value.name] !== undefined)) {
          if (name === value.name) {
            scopeFunctions[name].exported = true;
          } else {
            scopeFunctions[name] = {
              exported: true,
              ast: scopeFunctions[value.name].ast
            }
          }
          return;
        }

        // Keep reference to in-place defined functions
        if (value.type === 'FunctionExpression') {
          scopeFunctions[name] = {
            exported: true,
            ast: value
          };
        }

      });

      return scopeFunctions;
    }

    return scopeFunctions;
  }, {});

  // Keep only the AST of known functions
  return Object.keys(functions).reduce(function(exportedFunc, name) {
    var fn = functions[name];
    if (fn.exported) {
      exportedFunc[name] = fn.ast;
    }
    return exportedFunc;
  }, {});
}

/**
 * Render the body of the function as a program
 *
 * @param {Object} ast - The function AST
 * @returns {String} Returns the rendered function body
 */
function renderFunction(ast) {

  // Functions that have only a return statement, skip the 'return' and
  // render only it's value
  if (ast.body.body[0].type === 'ReturnStatement') {
    return escodegen.generate(ast.body.body[0].argument);
  }

  // Otherwise render the function body as a program fragment
  return escodegen.generate({
    type: 'Program',
    body: ast.body.body,
    sourceType: 'script'
  });

}

/**
 * Replace any identifier AST node found in the tree with a replacement node
 * given in the `withAst` argument.
 *
 * This function also checks if the identifier is shadowed at some particular
 * path of the AST and if yes, it does not replace it.
 *
 * @param {String} name - The name of the identifier
 * @param {Object} withAst - The AST node to replace with
 * @param {Object} inAst - The AST tree to search within
 * @returns {Object} Returns the modified AST.
 */
function replaceIdentifier(name, withAst, inAst) {
  if ((inAst.type === 'Identifier') && (inAst.name === name)) {
    return withAst;
  }

  // If we have a VariableDeclaration that shadows the given identifier
  // in the current body scope, pass the current contents as-is
  if (Array.isArray(inAst.body)) {
    var isShadowed = false;
    inAst.body.forEach(function(node) {

      //
      // Variable declarations can shadow this identifier
      //
      // var name = ...
      //
      if (node.type === 'VariableDeclaration') {
        node.declarations.forEach(function(node) {
          if (node.id.name === name) {
            isShadowed = true;
          }
        });
      }

      //
      // For statements can also shadow this identifier
      //
      // for (var name = ... ; ; ) {
      //
      if (node.type === 'ForStatement') {
        if (node.init && (node.init.type === 'VariableDeclaration')) {
          node.init.declarations.forEach(function(node) {
            if (node.id.name === name) {
              isShadowed = true;
            }
          });
        }
      }

    });

    // If we are shadowed we cannot do more
    if (isShadowed) {
      return inAst;
    }
  }

  // Recursively replace identifiers in the tree
  return Object.keys(inAst).reduce(function(newAst, key) {
    var value = inAst[key];

    if (Array.isArray(value)) {
      newAst[key] = value.map(replaceIdentifier.bind({}, name, withAst));
    } else if ((typeof value === 'object') && (value !== null)) {
      newAst[key] = replaceIdentifier(name, withAst, value);
    } else {
      newAst[key] = value;
    }

    return newAst;
  }, {});
}

/**
 * Compile the ASTs for the specified arguments expression
 *
 * @param {String} expression - The javascript expression for which to compile an AST
 * @returns {Arrays} Returns the array of the arguments as ASTs
 */
function compileArgumentAst(argsExpression) {
  return esprima.parse('X('+argsExpression+')')
    .body[0].expression.arguments;
}

/**
 * Load module contents, trying the various different extensions defined in the
 *
 * @param {String} modulePath - The path to the module
 * @param {Object} options - The webpack options from wihch to extract extensions
 * @returns {String} Returns the file contents
 */
function loadModuleContents(modulePath, options) {
  var extensions = options && options.resolve && options.resolve.extensions || [ '', '.js' ];
  return extensions.reduce(function(payload, ext) {

    // Pass-down payload if found
    if (payload !== null) {
      return payload;
    }

    // Load contents or null on loading error
    try {
      return fs.readFileSync(modulePath + ext);
    } catch(e) {
      return null;
    }

  }, null);
}

/**
 * Export the webpack replace function
 */
module.exports = function(source) {
  this.cacheable();

  // Replace all the %inline macro encounters
  return source.replace(INLINE_MACRO, (function(m, gIndent, gAssignExpr, gFile, gFunction, gArgs) {

    // Resolve filename
    var filePath = path.resolve(this.context, gFile);

    // Load file and extract AST
    var ast = esprima.parse(loadModuleContents(filePath, this.options), { sourceType: 'module' })
    this.addDependency(filePath);

    // Locate the correct function AST
    var exportedFn = getExportedFunctions(ast);
    var fnAst = exportedFn[gFunction];
    if (!fnAst) {
      this.emitError('Trying to inline unknown function ' + gFunction + ' in module ' + gFile);
      return '/* Unknown inline ' + gFunction + ' */';
    }

    // Compile the arguments ast
    var fnArgs = compileArgumentAst(gArgs);
    if (fnArgs.length !== fnAst.params.length) {
      this.emitError('Function ' + gFunction + ' is expecting exactly ' +
        fnAst.params.length + ' arguments, but got ' + fnArgs.length);
      return '/* Invalid syntax for ' + gFunction + ' */';
    }

    // Replace arguments in the function ast
    for (var i=0; i<fnArgs.length; ++i) {
      fnAst = replaceIdentifier( fnAst.params[i].name, fnArgs[i], fnAst );
    }

    // Compile the code and properly indent it;
    var code = renderFunction(fnAst);
    if (gAssignExpr) {
      code = gIndent + gAssignExpr + code.replace(/\r?\n/g, '\n'+gIndent+'    ');
    } else {
      code = gIndent + code.replace(/\r?\n/g, '\n'+gIndent);
    }

    console.log(code);
    return code;

  }).bind(this));

};
