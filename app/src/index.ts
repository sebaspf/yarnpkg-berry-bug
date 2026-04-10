
// NO imports — all symbols (User, greet, DEFAULT_USER) are exported by 'shared'
// but deliberately not imported here.
//
// When source.addMissingImports runs on save, TypeScript's importFixes computes
// module specifiers for 'shared', triggering the bug: a recursive directory watcher
// is created on a truncated path prefix (like /home/asdfg/).

const user: User = { id: "1", name: "World", email: "world@example.com" };

console.log(greet(user));
console.log(DEFAULT_USER);
