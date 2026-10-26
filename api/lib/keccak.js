// Keccak-256 (Ethereum's pre-standard SHA3 variant), used ONLY for ABI selectors/event IDs.
// Never used for private-key handling, signing, or encryption.
const MASK=(1n<<64n)-1n;
const ROT=[
  0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14
];
const RC=[
  0x0000000000000001n,0x0000000000008082n,0x800000000000808an,0x8000000080008000n,
  0x000000000000808bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,
  0x000000000000008an,0x0000000000000088n,0x0000000080008009n,0x000000008000000an,
  0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,
  0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,
  0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n
];
function rol(a,b){const n=BigInt(b);return n===0n?a:((a<<n)|(a>>(64n-n)))&MASK;}
function keccakF(a){
  for(let r=0;r<24;r++){
    const c=Array(5).fill(0n),d=Array(5).fill(0n),b=Array(25).fill(0n);
    for(let x=0;x<5;x++) for(let y=0;y<5;y++) c[x]^=a[x+5*y];
    for(let x=0;x<5;x++) d[x]=c[(x+4)%5]^rol(c[(x+1)%5],1);
    for(let x=0;x<5;x++) for(let y=0;y<5;y++) a[x+5*y]^=d[x];
    for(let x=0;x<5;x++) for(let y=0;y<5;y++) b[y+5*((2*x+3*y)%5)]=rol(a[x+5*y],ROT[x+5*y]);
    for(let x=0;x<5;x++) for(let y=0;y<5;y++) a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]);
    a[0]^=RC[r];
  }
}
export function keccak256(input){
  const bytes = typeof input==='string' ? new TextEncoder().encode(input) : input;
  const size=Math.ceil((bytes.length+1)/136)*136;
  const padded=new Uint8Array(size);padded.set(bytes);padded[bytes.length]=0x01;padded[size-1]|=0x80;
  const a=Array(25).fill(0n);
  for(let offset=0;offset<padded.length;offset+=136){
    for(let i=0;i<136;i++) a[Math.floor(i/8)] ^= BigInt(padded[offset+i]) << BigInt(8*(i%8));
    keccakF(a);
  }
  const out=new Uint8Array(32);
  for(let i=0;i<32;i++) out[i]=Number((a[Math.floor(i/8)] >> BigInt(8*(i%8)))&255n);
  return `0x${Buffer.from(out).toString('hex')}`;
}
export function selector(signature){return keccak256(signature).slice(0,10);}
