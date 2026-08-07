// Minimaler SMTP-Sink zum Testen: nimmt Mails an, protokolliert Zeitstempel,
// Empfaenger und Betreff nach stdout und in eine JSONL-Datei.
const net = require("node:net");
const fs = require("node:fs");

const PORT = Number(process.argv[2] || 2525);
const LOG = process.argv[3] || "/tmp/smtpsink.jsonl";

let count = 0;

const server = net.createServer((sock) => {
  let buf = "";
  let inData = false;
  let data = "";
  const state = { from: null, to: [] };

  const send = (line) => sock.write(line + "\r\n");
  send("220 sink.test ESMTP ready");

  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");

    while (true) {
      const idx = buf.indexOf("\r\n");
      if (idx === -1) break;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      if (inData) {
        if (line === ".") {
          inData = false;
          count++;
          const subject = (/^Subject:\s*(.*)$/im.exec(data) || [])[1] || "";
          const entry = {
            n: count,
            at: new Date().toISOString(),
            to: state.to.slice(),
            from: state.from,
            subject: subject.trim(),
            hasUnsubHeader: /^List-Unsubscribe:/im.test(data),
            bytes: data.length,
          };
          fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
          console.log(`#${count} ${entry.at} -> ${entry.to.join(",")} | ${entry.subject}`);
          data = "";
          state.to = [];
          send("250 2.0.0 Ok: queued");
        } else {
          data += line + "\n";
        }
        continue;
      }

      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
        send("250-sink.test");
        send("250-AUTH PLAIN LOGIN");
        send("250 8BITMIME");
      } else if (upper.startsWith("AUTH")) {
        send("235 2.7.0 Authentication successful");
      } else if (upper.startsWith("MAIL FROM")) {
        state.from = (/<([^>]*)>/.exec(line) || [])[1] || line;
        send("250 2.1.0 Ok");
      } else if (upper.startsWith("RCPT TO")) {
        state.to.push((/<([^>]*)>/.exec(line) || [])[1] || line);
        send("250 2.1.5 Ok");
      } else if (upper === "DATA") {
        inData = true;
        send("354 End data with <CR><LF>.<CR><LF>");
      } else if (upper.startsWith("QUIT")) {
        send("221 2.0.0 Bye");
        sock.end();
      } else if (upper.startsWith("RSET")) {
        state.to = [];
        send("250 2.0.0 Ok");
      } else {
        send("250 2.0.0 Ok");
      }
    }
  });

  sock.on("error", () => {});
});

server.listen(PORT, "127.0.0.1", () => console.log(`SMTP-Sink auf 127.0.0.1:${PORT}, Log: ${LOG}`));
