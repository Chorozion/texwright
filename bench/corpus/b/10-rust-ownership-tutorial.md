---
title: "Getting Started with Rust Ownership"
subtitle: "Moves, borrows, and slices, with the compiler errors you will actually see"
author: "A hands-on tutorial"
date: "October 2026"
---

# Introduction

Ownership is the feature that makes Rust different from almost every other language you have used. It is how Rust guarantees memory safety without a garbage collector, and it is also the main reason new Rust programmers spend their first week arguing with the compiler.

This tutorial walks through ownership one idea at a time. Each section has a short program you can run, and where the compiler rejects code, you will see the real error message and learn how to read it. By the end you should be able to:

- explain what happens when a value is moved, copied, or cloned;
- choose between passing `T`, `&T`, and `&mut T` to a function;
- use string slices (`&str`) and understand why they cannot outlive their data;
- read and fix the four borrow-checker errors that beginners hit most often.

**Prerequisites.** Basic programming experience and a Rust toolchain. If you don't have one, install it with [rustup](https://rustup.rs) and check:

```console
$ rustc --version
rustc 1.89.0 (29483883e 2025-08-04)
$ cargo --version
cargo 1.89.0 (c24e10642 2025-06-23)
```

Any recent stable version works. Create a project to experiment in:

```console
$ cargo new ownership-demo
    Creating binary (application) `ownership-demo` package
$ cd ownership-demo
$ cargo run
   Compiling ownership-demo v0.1.0 (/home/you/ownership-demo)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.48s
     Running `target/debug/ownership-demo`
Hello, world!
```

Replace the contents of `src/main.rs` with each example as you go.

# 1. Why ownership exists

Every program has to decide when memory is freed. Languages like C leave it to you, which leads to use-after-free bugs and leaks. Languages like Java, Go, and Python use a garbage collector, which costs runtime overhead and makes timing less predictable.

Rust takes a third path: the compiler tracks, at compile time, which variable is responsible for each piece of heap memory, and inserts the code to free it at exactly the right point. That responsibility is called **ownership**, and it follows three rules:

1. Each value in Rust has an **owner**.
2. There can be only **one owner at a time**.
3. When the owner goes **out of scope**, the value is dropped (its memory is freed).

Everything else in this tutorial follows from these three rules.

# 2. Scope and `drop`

Start with a `String`. Unlike a string literal, which is baked into the binary, a `String` stores its text on the heap so it can grow.

```rust
fn main() {
    {                                   // s is not valid here; not yet declared
        let s = String::from("hello");  // s is valid from this point forward
        println!("{s}");
    }                                   // scope ends: s is dropped, heap memory freed
    // println!("{s}");                 // error: cannot find value `s` in this scope
}
```

At the closing brace, Rust calls `drop` on `s` automatically. You never write `free`, and you can never forget to.

# 3. Moves

Here is the first surprise. Try this program:

```rust
fn main() {
    let s1 = String::from("hello");
    let s2 = s1;

    println!("{s1}, world!");
}
```

It does not compile:

```text
error[E0382]: borrow of moved value: `s1`
 --> src/main.rs:5:15
  |
2 |     let s1 = String::from("hello");
  |         -- move occurs because `s1` has type `String`, which does not implement the `Copy` trait
3 |     let s2 = s1;
  |              -- value moved here
4 |
5 |     println!("{s1}, world!");
  |               ^^^^ value borrowed here after move
  |
help: consider cloning the value if the performance cost is acceptable
  |
3 |     let s2 = s1.clone();
  |                ++++++++
```

Read the error from the bottom up. Line 5 uses `s1`. Line 3 moved the value out of `s1`. Line 2 explains why it was a move: `String` does not implement `Copy`.

What happened in memory? A `String` is three words on the stack (a pointer, a length, and a capacity) pointing to a buffer on the heap. `let s2 = s1;` copies the three stack words but not the heap buffer. If both `s1` and `s2` stayed valid, both would try to free the same buffer when they went out of scope: a double free. Rust prevents this by treating `s1` as **moved**. It is no longer usable, and only `s2` will free the buffer.

# 4. Clone and Copy

If you really want two independent strings, ask for a deep copy explicitly:

```rust
fn main() {
    let s1 = String::from("hello");
    let s2 = s1.clone();   // allocates a new heap buffer and copies the bytes

    println!("s1 = {s1}, s2 = {s2}");
}
```

The call to `clone` is visible in the code, which is the point: expensive copies should never happen by accident.

Simple values behave differently:

```rust
fn main() {
    let x = 5;
    let y = x;             // x is copied, not moved

    println!("x = {x}, y = {y}");
}
```

This compiles because integers implement the `Copy` trait. A type can be `Copy` only if it lives entirely on the stack and has no cleanup to perform. The common `Copy` types are:

| Type | `Copy`? | Why |
|---|:---:|---|
| `i32`, `u64`, `f64`, `bool`, `char` | Yes | Fixed size, no heap data |
| `(i32, f64)` | Yes | Tuple of `Copy` types |
| `[u8; 16]` | Yes | Array of `Copy` types |
| `&T` (shared reference) | Yes | Copying a reference does not copy the data |
| `String`, `Vec<T>`, `Box<T>` | No | Own heap memory that must be freed exactly once |
| `&mut T` (mutable reference) | No | Would break the "one mutable borrow" rule |

# 5. Ownership and functions

Passing a value to a function works exactly like assignment: it moves or copies.

```rust
fn main() {
    let s = String::from("hello");
    takes_ownership(s);             // s is moved into the function...
    // println!("{s}");             // ...so this would be an error

    let n = 5;
    makes_copy(n);                  // i32 is Copy, so n is still usable
    println!("n is still {n}");

    let s2 = gives_ownership();     // return values move out to the caller
    println!("got back: {s2}");
}

fn takes_ownership(text: String) {
    println!("took: {text}");
}                                   // text goes out of scope and is dropped here

fn makes_copy(value: i32) {
    println!("copied: {value}");
}

fn gives_ownership() -> String {
    String::from("yours")
}
```

Output:

```text
took: hello
copied: 5
n is still 5
got back: yours
```

Moving values in and back out of every function would be tedious. That is what references are for.

# 6. Borrowing with references

A **reference** lets you use a value without taking ownership of it. Creating a reference is called **borrowing**.

```rust
fn main() {
    let s1 = String::from("hello");
    let len = calculate_length(&s1);   // lend s1 to the function

    println!("The length of '{s1}' is {len}.");   // s1 is still ours
}

fn calculate_length(s: &String) -> usize {
    s.len()
}   // s goes out of scope, but it doesn't own the String, so nothing is dropped
```

The `&` in `&s1` creates a reference; the `&String` in the signature says the function borrows a `String` rather than taking it. References are immutable by default, so `calculate_length` cannot change the string.

## Mutable references

To let a function modify borrowed data, use `&mut`:

```rust
fn main() {
    let mut s = String::from("hello");
    change(&mut s);
    println!("{s}");   // prints "hello, world"
}

fn change(s: &mut String) {
    s.push_str(", world");
}
```

Note that three things must be marked: the variable (`let mut s`), the borrow (`&mut s`), and the parameter type (`&mut String`).

## The borrowing rules

Mutable references come with one big restriction. At any given time, you can have **either**:

- any number of shared references (`&T`), **or**
- exactly one mutable reference (`&mut T`),

but not both. This program breaks the rule:

```rust
fn main() {
    let mut s = String::from("hello");

    let r1 = &mut s;
    let r2 = &mut s;

    println!("{r1}, {r2}");
}
```

```text
error[E0499]: cannot borrow `s` as mutable more than once at a time
 --> src/main.rs:5:14
  |
4 |     let r1 = &mut s;
  |              ------ first mutable borrow occurs here
5 |     let r2 = &mut s;
  |              ^^^^^^ second mutable borrow occurs here
6 |
7 |     println!("{r1}, {r2}");
  |               ---- first borrow later used here
```

The rule exists to prevent **data races** at compile time: two pointers to the same data, at least one writing, with no synchronization. In single-threaded code it also prevents subtler bugs, such as holding a reference into a `Vec` while pushing to it (which may reallocate and leave the reference dangling).

A borrow lasts only until its **last use**, not until the end of the block. So this version compiles:

```rust
fn main() {
    let mut s = String::from("hello");

    let r1 = &s;
    let r2 = &s;
    println!("{r1} and {r2}");   // last use of r1 and r2

    let r3 = &mut s;             // fine: no shared borrows are still in use
    r3.push('!');
    println!("{r3}");
}
```

## No dangling references

Rust also guarantees that a reference never outlives the data it points to. Try returning a reference to a local variable:

```rust
fn dangle() -> &String {
    let s = String::from("hello");
    &s
}   // s is dropped here, so the reference would point to freed memory
```

```text
error[E0106]: missing lifetime specifier
 --> src/main.rs:1:16
  |
1 | fn dangle() -> &String {
  |                ^ expected named lifetime parameter
  |
  = help: this function's return type contains a borrowed value, but there is no value for it to be borrowed from
```

The help line is the important one: the function has no input to borrow from, so the returned reference could only point at something local. The fix is to return the owned `String` itself:

```rust
fn no_dangle() -> String {
    String::from("hello")   // ownership moves to the caller; nothing is freed
}
```

# 7. Slices

A **slice** is a reference to a contiguous part of a collection. The string slice type is `&str`. Here is a function that returns the first word of a string:

```rust
fn first_word(s: &str) -> &str {
    for (i, byte) in s.bytes().enumerate() {
        if byte == b' ' {
            return &s[..i];
        }
    }
    s
}

fn main() {
    let sentence = String::from("hello world");
    let word = first_word(&sentence);   // &String coerces to &str
    println!("first word: {word}");

    let literal = "good morning";       // string literals are already &str
    println!("first word: {}", first_word(literal));
}
```

Taking `&str` rather than `&String` makes the function more general: it accepts both `String` values (through automatic deref coercion) and literals.

Because `word` borrows from `sentence`, the compiler will not let `sentence` change while `word` is in use. Keep `first_word` at the top of the file and replace `main` with:

```rust
fn main() {
    let mut s = String::from("hello world");
    let word = first_word(&s);

    s.clear();   // tries to empty the string

    println!("the first word is: {word}");
}
```

```text
error[E0502]: cannot borrow `s` as mutable because it is also borrowed as immutable
  --> src/main.rs:14:5
   |
12 |     let word = first_word(&s);
   |                           -- immutable borrow occurs here
13 |
14 |     s.clear();   // tries to empty the string
   |     ^^^^^^^^^ mutable borrow occurs here
15 |
16 |     println!("the first word is: {word}");
   |                                  ------ immutable borrow later used here
```

In a language without a borrow checker, `word` would silently become garbage after `clear`. Here the bug is a compile error. The fix is to finish using `word` before modifying `s`, or to copy the word into its own `String` with `word.to_string()`.

# 8. Putting it together

The following program counts words without copying any of them. The returned map holds `&str` slices that borrow from the input text.

```rust
use std::collections::HashMap;

fn word_counts(text: &str) -> HashMap<&str, usize> {
    let mut counts = HashMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word).or_insert(0) += 1;
    }
    counts
}

fn main() {
    let text = String::from("the quick brown fox jumps over the lazy dog the end");
    let counts = word_counts(&text);

    let mut pairs: Vec<(&str, usize)> = counts.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));

    for (word, n) in pairs.iter().take(3) {
        println!("{word}: {n}");
    }
}
```

```text
the: 3
brown: 1
dog: 1
```

The signature `fn word_counts(text: &str) -> HashMap<&str, usize>` contains an elided lifetime: the compiler infers that the slices in the map borrow from `text`. As a result, `text` must stay alive as long as `counts` or `pairs` is in use. Add `drop(text);` right after the call to `word_counts` and the compiler will point to exactly where the map still needs it.

# 9. Quick reference

| You want to... | Use | Example signature |
|---|---|---|
| Read data without taking it | Shared reference | `fn len(s: &str) -> usize` |
| Modify the caller's data | Mutable reference | `fn push_all(v: &mut Vec<i32>)` |
| Keep or consume the data (store it, send it to a thread) | Owned value | `fn spawn_worker(job: Job)` |
| Give the caller new data | Return an owned value | `fn load() -> String` |
| Duplicate heap data | `.clone()` | `let copy = original.clone();` |
| Share ownership in one thread | `Rc<T>` | `let a = Rc::new(data);` |
| Share ownership across threads | `Arc<T>`, with `Mutex<T>` to mutate | `let a = Arc::new(Mutex::new(data));` |

A good default when writing a function: take `&str` or `&[T]` for inputs you only read, `&mut T` for inputs you change, and take ownership only when you need to keep the value.

# 10. Exercises

1. Write `fn longest_word(s: &str) -> &str` that returns the longest whitespace-separated word. Why does it compile without any lifetime annotations?
2. Change `calculate_length` to take `&str` instead of `&String`, and call it with both a `String` and a string literal.
3. The following code does not compile. Predict the error code before running it, then fix it in two different ways.

    ```rust
    fn main() {
        let mut v = vec![1, 2, 3];
        let first = &v[0];
        v.push(4);
        println!("first = {first}");
    }
    ```

4. Write a function `fn append_exclaim(s: String) -> String` and a function `fn append_exclaim_in_place(s: &mut String)`. When would you choose each?
5. *(Stretch.)* Modify `word_counts` so the map owns its keys (`HashMap<String, usize>`). What changes in `main`, and what is the cost?

# Further reading

- *The Rust Programming Language*, Chapter 4, "Understanding Ownership": <https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html>
- *Rust by Example*, "Scoping rules": <https://doc.rust-lang.org/rust-by-example/scope.html>
- The compiler's own explanations: run `rustc --explain E0382` (or any other code) for a detailed description and examples.
