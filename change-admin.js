const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const storePath = path.join(__dirname, "data", "store.json");

function ask(question, hidden = false) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  if (!hidden) {
    return new Promise(resolve => rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    }));
  }

  return new Promise(resolve => {
    process.stdout.write(question);
    let answer = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = character => {
      if (character === "\r" || character === "\n") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        rl.close();
        process.stdout.write("\n");
        resolve(answer);
        return;
      }
      if (character === "\u0003") process.exit(130);
      if (character === "\u007f" || character === "\b") {
        if (answer.length) answer = answer.slice(0, -1);
        return;
      }
      answer += character;
      process.stdout.write("*");
    };

    process.stdin.on("data", onData);
  });
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(`scrypt$16384$8$1$${salt.toString("hex")}$${derivedKey.toString("hex")}`);
    });
  });
}

async function main() {
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  if (!Array.isArray(store.users)) throw new Error("No users array found in data/store.json.");

  const administrator = store.users.find(user => user.role === "Administrator");
  if (!administrator) throw new Error("No administrator account found in data/store.json.");

  const name = await ask(`Administrator name [${administrator.name}]: `);
  const email = await ask(`New email [${administrator.email}]: `);
  const password = await ask("New password (12+ characters, leave blank to keep current): ", true);

  if (!name && !email && !password) {
    throw new Error("No changes entered.");
  }

  if (email) {
    const normalizedEmail = email.toLowerCase();
    if (!normalizedEmail.includes("@")) throw new Error("Enter a valid email address.");
    if (store.users.some(user => user.id !== administrator.id && String(user.email || "").toLowerCase() === normalizedEmail)) {
      throw new Error("That email is already used by another account.");
    }
    administrator.email = normalizedEmail;
  }

  if (name) administrator.name = name;
  if (password) {
    if (password.length < 12) throw new Error("Password must be at least 12 characters.");
    administrator.passwordHash = await hashPassword(password);
  }

  const temporaryPath = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(temporaryPath, storePath);
  console.log("Administrator account updated successfully.");
  console.log("Restart the server if it is currently running.");
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
