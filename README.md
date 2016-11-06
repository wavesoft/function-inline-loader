# function-inline-loader

A webpack loader than enables inlining functions from other modules

## Usage

Create a node module as you would normally do:

```js
export function staticDefinition() {
  return {a: '1', b: '2'};
}

export function expensiveCalculations(arg1, arg2) {
  ...
}
```

Then inline the functions instead of calling them, using the `%inline` macro:

```js
function doSomeWork() {
  const definitions = %inline('path/to/module').staticDefinition();

  ...
  %inline('path/to/module').expensiveCalculations(arg1, arg2);
  ...
}
```

The webpack loader will automagically expand the contents of the function you are in-lining in the location of the inline macro.

## Installation

First install the node module:

```
npm install --save-dev function-inline-loader
```

Then install it as a preloader on webpack:

```js
    preLoaders: [
      {
        test: /.js$/,
        exclude: /node_modules/,
        loader: 'function-inline-loader'
      }
    ],
```

## Caveats

The macro tries it's best to behave like a javascript expression but it's *NOT*!

* Make sure to always terminate the `%inline` macro with `);` (yes, the semi-colon is important)
* You can get wild with the arguments, you can even write anonymous in-line functions, but make sure the `);` expression never appears at the end of a line! For example:

```js
%inline('path/to/module').inlineFunction(
    function() {
      return (1+2)
      // WARNING: Avoid adding termination ';'
    }
  );
```

The loader will parse the javascript AST of the refered module and identify all the functions exported by it. However not all expressions are yet supported. Below you can see what is currently supported:

### Will NOT work

The loader will not detect exported functions that were previously imported by other modules.

```js
import { otherFunction } from 'path/to/module';

module.exports = {
  otherFunction
}
```

### Works

You can use the classic ES6 export syntax:

```js
// As an exported function
export function exportedFunction() {
  ...
}

// As a static function on the default class
export default class {
  static exportedFunction2() {
    ...
  }
}
```

Or the regular CommonJs syntax:

```js
// Function definition
function exportedFunction() {

}

// Or function expression assigned to a variable
var exportedFunction2 = function() {

}

// Make sure to export your functions
module.exports = {
  exportedFunction,
  exportedFunction2,

  // You can also define functions in the object you export
  exportedFunction3() {
    ...
  }
};
```
